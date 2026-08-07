import { useEffect, useRef, useState } from 'react';
import { Archive, BarChart3, BookOpen, BookUser, Boxes, Calendar, CalendarClock, ChevronDown, ChevronRight, ChevronUp, Clock, FileSignature, FileText, Files, FolderOpen, Landmark, LayoutDashboard, Library, LogOut, Megaphone, MessageSquare, Percent, Pin, PinOff, Receipt, Sparkles, StickyNote, Ticket, TrendingUp, Truck, Users, X } from 'lucide-react';
import type { AppData, Organization, OrganizationRole } from '../types';
import { GlobalSearch, type SearchResult } from './GlobalSearch';
import { SETTINGS_TABS, type SettingsTab } from '../features/SimplePages';
import { Select } from './Ui';
import { FULL_PERMISSIONS, type Permissions } from '../lib/permissions';

type Page = 'dashboard'|'gerrie'|'weekplanner'|'calendar'|'calendar-settings'|'meeting-booking'|'time'|'stats'|'content'|'notes'|'documents'|'clients'|'client'|'projects'|'project-planning'|'tickets'|'chat'|'marketing'|'quotes'|'contracts'|'invoices'|'suppliers'|'purchase-invoices'|'ledger'|'bank'|'assets'|'pnl'|'vat-returns'|'corporate-tax'|'dga'|'shareholders'|'fiscal-years'|'archive'|'settings'|'project'|'gallery';

const items = [
  ['dashboard', LayoutDashboard, 'Dashboard'],
  ['gerrie', Sparkles, 'Gerrie'],
  ['chat', MessageSquare, 'Chat'],
  ['weekplanner', Calendar, 'Weekplanner'],
  ['calendar', Calendar, 'Agenda'],
  ['time', Clock, 'Uren'],
  ['stats', BarChart3, 'Statistieken'],
  ['content', Library, 'Inhoud'],
  ['clients', Users, 'Klanten'],
  ['projects', FolderOpen, 'Projecten'],
  ['tickets', Ticket, 'Tickets'],
  ['marketing', Megaphone, 'Marketing'],
  ['finance', Receipt, 'Financiën'],
] as const;

const financePages: Page[] = ['quotes', 'contracts', 'invoices', 'suppliers', 'purchase-invoices', 'ledger', 'bank', 'assets', 'pnl', 'vat-returns', 'corporate-tax', 'dga', 'shareholders', 'fiscal-years'];
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
  onNewEntity,
  onPage,
  onSearchNavigate,
  userEmail = null,
  onOpenSettings,
  onSignOut,
  clientEmailUnread = 0,
  ticketUnread = 0,
  chatUnread = 0,
  mobileOpen = false,
  onCloseMobile,
  pinned = false,
  onTogglePin,
  permissions = FULL_PERMISSIONS,
}: {
  page: Page;
  data: AppData;
  organizations: Organization[];
  activeOrganizationId: string | null;
  activeRole: OrganizationRole | null;
  onOrganization: (id: string) => void;
  onNewOrganization: () => void;
  /** Alleen gevuld met de zakelijke module: een administratie onder deze organisatie. */
  onNewEntity?: (() => void) | null;
  onPage: (p: Page) => void;
  onSearchNavigate: (result: SearchResult) => void;
  userEmail?: string | null;
  onOpenSettings: (tab?: SettingsTab) => void;
  onSignOut: () => void;
  clientEmailUnread?: number;
  ticketUnread?: number;
  chatUnread?: number;
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  /** Modulerechten van het ingelogde teamlid; modules zonder leesrecht
   *  verschijnen niet in het menu. Standaard alles zichtbaar. */
  permissions?: Permissions;
}) {
  const [financeOpen, setFinanceOpen] = useState(() => financePages.includes(page));
  const [projectsOpen, setProjectsOpen] = useState(() => projectPages.includes(page));
  // Account-menu onderin: opent alle instellingen + uitloggen boven de avatar.
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userRef = useRef<HTMLDivElement>(null);
  const userTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (financePages.includes(page)) setFinanceOpen(true);
    if (projectPages.includes(page)) setProjectsOpen(true);
  }, [page]);

  // Sluit het account-menu bij een klik erbuiten of met Escape.
  useEffect(() => {
    if (!userMenuOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (userRef.current && !userRef.current.contains(event.target as Node)) setUserMenuOpen(false);
    };
    // Escape sluit het menu én zet de focus terug op de avatar-knop (menu-button-patroon),
    // zodat toetsenbordgebruikers hun plek in de zijbalk houden.
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setUserMenuOpen(false); userTriggerRef.current?.focus(); } };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onPointer); document.removeEventListener('keydown', onKey); };
  }, [userMenuOpen]);

  // AI-gebruik is alleen zichtbaar voor owners/admins — zelfde regel als op de instellingenpagina.
  const canAdmin = activeRole === 'owner' || activeRole === 'admin';
  const settingsTabs = SETTINGS_TABS.filter(tab => tab.id !== 'ai' || canAdmin);
  const emailLocalPart = (userEmail ?? '').split('@')[0] ?? '';
  const accountName = emailLocalPart || 'Account';
  const accountInitials = (() => {
    const source = emailLocalPart || (userEmail ?? '');
    if (!source) return '?';
    const parts = source.split(/[^a-zA-Z0-9]+/).filter(Boolean);
    const letters = parts.length >= 2 ? `${parts[0][0]}${parts[1][0]}` : source.slice(0, 2);
    return letters.toUpperCase();
  })();

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

  function openFinancePage(target: 'quotes' | 'contracts' | 'invoices' | 'suppliers' | 'purchase-invoices' | 'ledger' | 'bank' | 'assets' | 'pnl' | 'vat-returns' | 'corporate-tax' | 'dga' | 'shareholders' | 'fiscal-years') {
    setFinanceOpen(true);
    onPage(target);
  }

  function openProjectPage(target: 'projects' | 'project-planning' | 'archive') {
    setProjectsOpen(true);
    onPage(target);
  }

  // Administraties onder hun moeder groeperen (holding + werk-BV). Een
  // administratie waarvan de moeder niet zichtbaar is — je bent wel lid van de
  // werk-BV maar niet van de holding — komt gewoon op het eerste niveau, anders
  // zou hij helemaal uit de lijst vallen.
  const visibleIds = new Set(organizations.map(org => org.id));
  const organizationGroups = organizations
    .filter(org => !org.parent_organization_id || !visibleIds.has(org.parent_organization_id))
    .map(root => ({
      root,
      children: organizations.filter(org => org.parent_organization_id === root.id),
    }));
  const hasEntities = organizationGroups.some(group => group.children.length > 0);

  return <aside className={`sidebar${mobileOpen ? ' is-open' : ''}${userMenuOpen ? ' user-open' : ''}`}>
    <div className="sidebar-head">
      <button type="button" className="sidebar-close" onClick={onCloseMobile} aria-label="Menu sluiten"><X size={20}/></button>
      <button type="button" className="sidebar-pin" onClick={onTogglePin} aria-pressed={pinned} aria-label={pinned ? 'Menu losmaken' : 'Menu vastzetten'} title={pinned ? 'Menu losmaken' : 'Menu vastzetten'}>{pinned ? <PinOff size={15}/> : <Pin size={15}/>}</button>
      <div className="app-brand"><div className="brand-icon">R</div><span>ResoFly</span></div>
      <div className="org-switcher">
        <label>{hasEntities ? 'Administratie' : 'Organisatie'}</label>
        <Select value={activeOrganizationId ?? ''} onChange={event => onOrganization(event.target.value)}>
          {organizationGroups.map(group => group.children.length === 0
            ? <option key={group.root.id} value={group.root.id}>{group.root.name}</option>
            : <optgroup key={group.root.id} label={group.root.name}>
                <option value={group.root.id}>{group.root.name}</option>
                {group.children.map(child => <option key={child.id} value={child.id}>{child.name}</option>)}
              </optgroup>)}
        </Select>
        <div className="org-meta">
          <span>{activeRole ?? 'geen rol'}</span>
          {onNewEntity && <button onClick={onNewEntity}>+ administratie</button>}
          <button onClick={onNewOrganization}>+ organisatie</button>
        </div>
      </div>
    </div>
    <nav className="sidebar-nav">
      <GlobalSearch data={data} onNavigate={onSearchNavigate} />
      <div className="nav-section"><span>Menu</span></div>
      {items.filter(([key]) => permissions.canOpenPage(key === 'finance' ? 'quotes' : key)).map(([key, Icon, label]) => {
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
              : <button className={`nav-item ${isActive ? 'active' : ''}`} onClick={() => onPage(key as Page)}><Icon size={16}/><span className="ni-label">{label}</span>{key === 'clients' && clientEmailUnread > 0 && <span className="nav-badge" title={`${clientEmailUnread} ongelezen bericht${clientEmailUnread === 1 ? '' : 'en'}`}>{clientEmailUnread > 99 ? '99+' : clientEmailUnread}</span>}{key === 'tickets' && ticketUnread > 0 && <span className="nav-badge" title={`${ticketUnread} ticket${ticketUnread === 1 ? '' : 's'} met nieuwe klant-activiteit`}>{ticketUnread > 99 ? '99+' : ticketUnread}</span>}{key === 'chat' && chatUnread > 0 && <span className="nav-badge" title={`${chatUnread} ongelezen chatbericht${chatUnread === 1 ? '' : 'en'}`}>{chatUnread > 99 ? '99+' : chatUnread}</span>}</button>}

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
            {/* Vennootschapsbelasting bestaat alleen bij een rechtsvorm die er
                zelfstandig belastingplichtig voor is; een eenmanszaak betaalt
                inkomstenbelasting en heeft hier niets te zoeken. */}
            {['bv', 'nv', 'cooperatie'].includes(data.companySettings?.legal_form ?? 'eenmanszaak') && (
              <button type="button" className={page === 'corporate-tax' ? 'active' : ''} onClick={() => openFinancePage('corporate-tax')}><Landmark size={13}/><span>Vennootschapsbelasting</span></button>
            )}
            {['bv', 'nv'].includes(data.companySettings?.legal_form ?? 'eenmanszaak') && (<>
              <button type="button" className={page === 'dga' ? 'active' : ''} onClick={() => openFinancePage('dga')}><Users size={13}/><span>DGA</span></button>
              {/* Aandelen, en dus een aandeelhoudersregister, bestaan alleen bij
                  een BV of NV. */}
              <button type="button" className={page === 'shareholders' ? 'active' : ''} onClick={() => openFinancePage('shareholders')}><BookUser size={13}/><span>Aandeelhouders</span></button>
            </>)}
            <button type="button" className={page === 'fiscal-years' ? 'active' : ''} onClick={() => openFinancePage('fiscal-years')}><CalendarClock size={13}/><span>Boekjaren</span></button>
          </div>}

          {key === 'content' && contentPages.includes(page) && <div className="nav-submenu nav-submenu-finance">
            <button type="button" className={page === 'content' ? 'active' : ''} onClick={() => onPage('content')}><Library size={13}/><span>Overzicht</span></button>
            <button type="button" className={page === 'notes' ? 'active' : ''} onClick={() => onPage('notes')}><StickyNote size={13}/><span>Notities</span></button>
            <button type="button" className={page === 'documents' ? 'active' : ''} onClick={() => onPage('documents')}><Files size={13}/><span>Documenten</span></button>
          </div>}
        </div>;
      })}
    </nav>

    <div className={`sidebar-user${userMenuOpen ? ' is-open' : ''}`} ref={userRef}>
      {userMenuOpen && <div className="user-menu" role="menu" aria-label="Account en instellingen">
        <div className="user-menu-head">
          <span className="umh-label">Ingelogd als</span>
          <span className="umh-email" title={userEmail ?? undefined}>{userEmail ?? 'Onbekend account'}</span>
        </div>
        <div className="user-menu-section">Instellingen</div>
        {settingsTabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            role="menuitem"
            className="user-menu-item"
            onClick={() => { onOpenSettings(tab.id); setUserMenuOpen(false); }}
          >
            <tab.Icon size={15}/><span>{tab.label}</span>
          </button>
        ))}
        <div className="user-menu-sep" aria-hidden="true" />
        <button
          type="button"
          role="menuitem"
          className="user-menu-item danger"
          onClick={() => { setUserMenuOpen(false); onSignOut(); }}
        >
          <LogOut size={15}/><span>Uitloggen</span>
        </button>
      </div>}

      <button
        ref={userTriggerRef}
        type="button"
        className={`user-trigger${userMenuOpen ? ' open' : ''}${page === 'settings' ? ' active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={userMenuOpen}
        onClick={() => setUserMenuOpen(open => !open)}
      >
        <span className="user-avatar" aria-hidden="true">{accountInitials}</span>
        <span className="user-meta">
          <span className="user-name">{accountName}</span>
          <span className="user-role">{activeRole ?? 'geen rol'}</span>
        </span>
        <ChevronUp size={16} className="user-caret" aria-hidden="true"/>
      </button>
    </div>
  </aside>;
}
