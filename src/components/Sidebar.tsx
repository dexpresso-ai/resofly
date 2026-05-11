import { Archive, BarChart3, Calendar, FileText, LayoutDashboard, Receipt, Settings, StickyNote, Ticket, Users } from 'lucide-react';
import type { Organization, OrganizationRole, Project } from '../types';

type Page = 'dashboard'|'weekplanner'|'calendar'|'stats'|'notes'|'clients'|'tickets'|'quotes'|'invoices'|'archive'|'settings'|'project';
const items = [
  ['dashboard', LayoutDashboard, 'Dashboard'], ['weekplanner', Calendar, 'Weekplanner'], ['calendar', Calendar, 'Kalender'], ['stats', BarChart3, 'Statistieken'], ['notes', StickyNote, 'Notities'], ['clients', Users, 'Klanten'], ['tickets', Ticket, 'Tickets'], ['quotes', FileText, 'Offertes'], ['invoices', Receipt, 'Facturen'], ['archive', Archive, 'Archief'], ['settings', Settings, 'Instellingen'],
] as const;

export function Sidebar({
  page,
  projects,
  activeProjectId,
  organizations,
  activeOrganizationId,
  activeRole,
  onOrganization,
  onNewOrganization,
  onPage,
  onProject,
  onNewProject,
}: {
  page: Page;
  projects: Project[];
  activeProjectId?: string | null;
  organizations: Organization[];
  activeOrganizationId: string | null;
  activeRole: OrganizationRole | null;
  onOrganization: (id: string) => void;
  onNewOrganization: () => void;
  onPage: (p: Page) => void;
  onProject: (id: string) => void;
  onNewProject: () => void;
}) {
  function openCalendarAnchor(anchor: 'agenda' | 'connections') {
    onPage('calendar');
    const hash = `#calendar-${anchor}`;
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('brandcore:calendar-anchor', { detail: { anchor } }));
    }, 80);
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
      {items.map(([key, Icon, label]) => (
        <div className="nav-item-wrap" key={key}>
          <button className={`nav-item ${page === key ? 'active' : ''}`} onClick={() => onPage(key as Page)}><Icon size={16}/><span className="ni-label">{label}</span></button>
          {key === 'calendar' && page === 'calendar' && <div className="nav-submenu">
            <button type="button" onClick={() => openCalendarAnchor('agenda')}>Agendaweergave</button>
            <button type="button" onClick={() => openCalendarAnchor('connections')}>Gekoppelde accounts</button>
          </div>}
        </div>
      ))}
      <div className="nav-section"><span>Projecten</span><button onClick={onNewProject}>+</button></div>
      {projects.filter(p => !p.archived).map(project => <button key={project.id} className={`nav-item ${activeProjectId === project.id ? 'active' : ''}`} onClick={() => onProject(project.id)}>
        <span className="ni-dot" style={{ background: project.color }}/><span className="ni-label">{project.name}</span>
      </button>)}
    </nav>
  </aside>;
}
