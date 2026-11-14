import { Fragment, useEffect, useRef, useState } from 'react';
import { Archive, BarChart3, BookOpen, BookUser, Boxes, Calendar, CalendarClock, CalendarRange, ChevronDown, ChevronRight, ChevronUp, Clock, ExternalLink, FileSignature, FileText, FolderOpen, Hourglass, Inbox, Landmark, LayoutDashboard, Library, Lock, LogOut, Megaphone, MessageSquare, Moon, Percent, Pin, PinOff, Receipt, RefreshCw, Scale, Sparkles, Sun, Ticket, TrendingUp, Truck, Users, Wallet, X } from 'lucide-react';
import type { AppData, Organization, OrganizationRole } from '../types';
import { GlobalSearch, type SearchResult } from './GlobalSearch';
import { SETTINGS_TABS, settingsTabRoleRule, type SettingsTab } from '../features/SimplePages';
import { Select } from './Ui';
import { BrandMark } from './BrandMark';
import { FULL_PERMISSIONS, isAccountantRole, type Permissions } from '../lib/permissions';
import { useTheme } from '../lib/theme';
import { useLook, type Look } from '../lib/look';
import { useBuildingReports } from '../lib/aiReports';
import type { StandaloneApp } from '../lib/standaloneApps';
import { useBackStep } from '../lib/useBackStep';

/** De looks in het accountmenu (Weergave). Deze zijbalk staat er alleen nog
 *  in Cockpit; Baken (de standaard), Zenit en Stroom hebben de rail met het
 *  uitklappaneel (ZenitNav). Vanuit hier kies je Baken terug. */
const LOOK_CHOICES: { look: Look; label: string; hint: string }[] = [
  { look: 'baken', label: 'Baken', hint: 'de standaard: licht werkvlak, donker commandovlak' },
  { look: 'cockpit', label: 'Cockpit', hint: 'de vorige look, met deze zijbalk' },
  { look: 'zenit', label: 'Zenit', hint: 'rustig, met de nachtrail' },
  { look: 'stroom', label: 'Stroom', hint: 'licht, glas en de stroom' },
];

export type Page = 'dashboard'|'gerrie'|'weekplanner'|'calendar'|'meeting-booking'|'time'|'stats'|'report'|'content'|'notes'|'documents'|'clients'|'client'|'communication'|'projects'|'project-planning'|'tickets'|'chat'|'marketing'|'quotes'|'contracts'|'invoices'|'suppliers'|'purchase-invoices'|'ledger'|'bank'|'assets'|'prepaid'|'pnl'|'vat-returns'|'corporate-tax'|'dga'|'shareholders'|'owners'|'fiscal-years'|'annual-accounts'|'archive'|'settings'|'project'|'gallery';

/**
 * Het menu in categorieën in plaats van dertien regels onder elkaar. Een groep
 * van twee of drie scan je in één oogopslag; de koppen zijn puur label — ze
 * klappen niets in en kosten dus geen extra klik. Agenda, Projecten en
 * Financiën houden hun eigen uitklapbare submenu. Een groep waarvan élk item
 * dichtstaat voor dit teamlid verdwijnt helemaal, kop en al.
 *
 * Agenda is de kop boven alles wat op de kalender staat: de agendaweergave, de
 * weekplanner en de boekingslinks. De agenda-instellingen zijn hier weg — die
 * wonen bij de rest van de instellingen (accountmenu → Instellingen → Agenda).
 *
 * Communicatie begint met Berichten: alle klantmail van de organisatie op één
 * pagina, inclusief de post die nog niet aan een klant gekoppeld is. Het
 * tabblad Communicatie per klant blijft daarnaast gewoon bestaan.
 */
const navGroups = [
  { id: 'overzicht', label: 'Overzicht', items: [
    ['dashboard', LayoutDashboard, 'Dashboard'],
    ['gerrie', Sparkles, 'Gerrie'],
  ] },
  { id: 'plannen', label: 'Plannen', items: [
    ['calendar', Calendar, 'Agenda'],
    ['time', Clock, 'Uren'],
  ] },
  { id: 'werk', label: 'Werk', items: [
    ['clients', Users, 'Klanten'],
    ['projects', FolderOpen, 'Projecten'],
    ['tickets', Ticket, 'Tickets'],
  ] },
  { id: 'financien', label: 'Financiën', items: [
    ['finance', Receipt, 'Financiën'],
  ] },
  { id: 'communicatie', label: 'Communicatie', items: [
    ['communication', Inbox, 'Berichten'],
    ['chat', MessageSquare, 'Chat'],
    ['marketing', Megaphone, 'Marketing'],
  ] },
  { id: 'kennis', label: 'Kennis & inzicht', items: [
    ['content', Library, 'Inhoud'],
    ['stats', BarChart3, 'Rapportages'],
  ] },
] as const;

/**
 * Mag deze menuregel er staan? Een kop met een submenu leeft zolang één van zijn
 * kinderen open is: Financiën hangt aan de offertes, en onder Agenda valt ook de
 * weekplanner — die hoort bij de module Projecten, niet bij Agenda.
 */
function canOpenNavItem(key: string, permissions: Permissions): boolean {
  if (key === 'finance') return permissions.canOpenPage('quotes');
  if (key === 'calendar') return permissions.canOpenPage('calendar') || permissions.canOpenPage('weekplanner');
  return permissions.canOpenPage(key);
}

const financePages: Page[] = ['quotes', 'contracts', 'invoices', 'suppliers', 'purchase-invoices', 'ledger', 'bank', 'assets', 'prepaid', 'pnl', 'vat-returns', 'corporate-tax', 'dga', 'shareholders', 'owners', 'fiscal-years', 'annual-accounts'];
const calendarPages: Page[] = ['calendar', 'meeting-booking'];
const projectPages: Page[] = ['projects', 'project', 'project-planning', 'weekplanner', 'archive'];
/**
 * Inhoud heeft géén submenu: één klik op "Inhoud" en je staat in het overzicht.
 * Notities en documenten zijn dáár een filter ("Weergeven"), geen eigen menuregel.
 * De pagina's blijven wel bestaan — de globale zoekfunctie en Gerrie openen een
 * notitie of document rechtstreeks — en dan hoort "Inhoud" op te lichten.
 */
const contentPages: Page[] = ['content', 'notes', 'documents'];
/** Een rapportage van Gerrie is een eigen pagina, maar hoort onder Rapportages. */
const reportPages: Page[] = ['stats', 'report'];

/** De instellingen in het accountmenu. AI-gebruik en API-sleutels zijn alleen
 *  zichtbaar voor owners/admins, en de agenda-instellingen alleen als de
 *  agenda-module openstaat — zelfde regels als op de instellingenpagina zelf. */
export function visibleSettingsTabs(activeRole: OrganizationRole | null, permissions: Permissions) {
  const canAdmin = activeRole === 'owner' || activeRole === 'admin';
  return SETTINGS_TABS.filter(tab => {
    // Boekhouder: alleen de financiële tabbladen; Boekhouder-toegang: beheer.
    const roleRule = settingsTabRoleRule(tab.id, activeRole);
    if (roleRule !== null) return roleRule;
    if (tab.id === 'ai' || tab.id === 'api') return canAdmin;
    if (tab.id === 'agenda') return permissions.canRead('calendar');
    return true;
  });
}

export interface SidebarProps {
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
  /** Ongelezen klantmail van dit teamlid — samen met `inboxOpen` de badge op Berichten. */
  messageUnread?: number;
  /** Post in de opvangbak die nog aan een klant gekoppeld moet worden (organisatiebreed). */
  inboxOpen?: number;
  ticketUnread?: number;
  chatUnread?: number;
  /** Kaarten op de beslislijst die op een beslissing wachten (badge op Gerrie). */
  decisionCount?: number;
  /** Per e-mail binnengekomen inkoopfacturen die op een mens wachten (badge op Financiën → Inkoopfacturen). */
  purchaseInboxOpen?: number;
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  /** Modulerechten van het ingelogde teamlid; modules zonder leesrecht
   *  verschijnen niet in het menu. Standaard alles zichtbaar. */
  permissions?: Permissions;
  /** Op de telefoon is er geen titelbalk meer: de werktab draagt de naam van de
   *  pagina. "Ververs" en de alleen-lezen-melding verhuizen daarom naar de kop
   *  van dit uitschuifmenu (alleen zichtbaar ≤760px, zie globals.css). */
  onRefresh?: () => void;
  refreshing?: boolean;
  readOnly?: boolean;
  /** De rapportages van Gerrie van dit teamlid: elk een eigen pagina onder Rapportages. */
  aiReports?: Array<{ id: string; title: string }>;
  activeAiReportId?: string | null;
  onOpenAiReport?: (id: string) => void;
  /** In een losse app (Agenda, Financiën, Communicatie): welke. Het merk noemt
   *  hem, en `permissions.canOpenPage` laat dan alleen zijn pagina's door. */
  standaloneApp?: StandaloneApp | null;
  /** In een losse app: de weg terug naar de hele werkruimte, onder het menu. */
  onOpenWorkspace?: () => void;
}

/** Zoveel rapportages staan er onder Rapportages in het menu; de rest via het overzicht. */
const MENU_REPORTS = 6;

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
  messageUnread = 0,
  inboxOpen = 0,
  ticketUnread = 0,
  chatUnread = 0,
  decisionCount = 0,
  purchaseInboxOpen = 0,
  mobileOpen = false,
  onCloseMobile,
  pinned = false,
  onTogglePin,
  permissions = FULL_PERMISSIONS,
  onRefresh,
  refreshing = false,
  readOnly = false,
  aiReports = [],
  activeAiReportId = null,
  onOpenAiReport,
  standaloneApp = null,
  onOpenWorkspace,
}: SidebarProps) {
  const [financeOpen, setFinanceOpen] = useState(() => financePages.includes(page));
  const [reportsOpen, setReportsOpen] = useState(() => reportPages.includes(page));
  // Rapportages waar Gerrie nu aan bouwt: een knipperend lichtje in het menu.
  const buildingReports = useBuildingReports();
  // Sta je op een rapportage, dan staat het submenu open: zo zie je welke het is.
  useEffect(() => { if (page === 'report') setReportsOpen(true); }, [page]);
  const [projectsOpen, setProjectsOpen] = useState(() => projectPages.includes(page));
  const [calendarOpen, setCalendarOpen] = useState(() => calendarPages.includes(page));
  // Account-menu onderin: opent alle instellingen + uitloggen boven de avatar.
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  // De terugknop van de telefoon sluit het accountmenu, zoals Escape.
  useBackStep(userMenuOpen, () => setUserMenuOpen(false));
  const [theme, setTheme] = useTheme();
  const [look, setLook] = useLook();
  const userRef = useRef<HTMLDivElement>(null);
  const userTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (financePages.includes(page)) setFinanceOpen(true);
    if (projectPages.includes(page)) setProjectsOpen(true);
    if (calendarPages.includes(page)) setCalendarOpen(true);
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

  const settingsTabs = visibleSettingsTabs(activeRole, permissions);
  // De rollen staan hier zoals ze in de database heten; de boekhouder in het Nederlands.
  const roleLabel = isAccountantRole(activeRole) ? 'boekhouder' : activeRole ?? 'geen rol';
  const purchaseInboxTitle = `${purchaseInboxOpen} per e-mail binnengekomen inkoopfactu${purchaseInboxOpen === 1 ? 'ur' : 'ren'} met aandacht nodig`;

  // De badge op Berichten telt wat aandacht vraagt: ongelezen post én post die
  // nog niet aan een klant hangt. De tooltip houdt de twee uit elkaar.
  const messageBadge = messageUnread + inboxOpen;
  const messageBadgeTitle = [
    messageUnread > 0 ? `${messageUnread} ongelezen bericht${messageUnread === 1 ? '' : 'en'}` : '',
    inboxOpen > 0 ? `${inboxOpen} bericht${inboxOpen === 1 ? '' : 'en'} nog niet aan een klant gekoppeld` : '',
  ].filter(Boolean).join(' · ');
  const emailLocalPart = (userEmail ?? '').split('@')[0] ?? '';
  const accountName = emailLocalPart || 'Account';
  const accountInitials = (() => {
    const source = emailLocalPart || (userEmail ?? '');
    if (!source) return '?';
    const parts = source.split(/[^a-zA-Z0-9]+/).filter(Boolean);
    const letters = parts.length >= 2 ? `${parts[0][0]}${parts[1][0]}` : source.slice(0, 2);
    return letters.toUpperCase();
  })();

  /** De agendaweergave zelf: navigeren én naar het rooster scrollen. */
  function openCalendarView() {
    setCalendarOpen(true);
    onPage('calendar');
    // Met history.state erin: daar staat de stap van de terugknop (lib/backButton.ts).
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#calendar-agenda`);
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('brandcore:calendar-anchor', { detail: { anchor: 'agenda' } }));
    }, 80);
  }

  function openCalendarPage(target: 'meeting-booking') {
    setCalendarOpen(true);
    onPage(target);
  }

  function openFinancePage(target: 'quotes' | 'contracts' | 'invoices' | 'suppliers' | 'purchase-invoices' | 'ledger' | 'bank' | 'assets' | 'prepaid' | 'pnl' | 'vat-returns' | 'corporate-tax' | 'dga' | 'shareholders' | 'owners' | 'fiscal-years' | 'annual-accounts') {
    setFinanceOpen(true);
    onPage(target);
  }

  function openProjectPage(target: 'projects' | 'project-planning' | 'weekplanner' | 'archive') {
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

  const organizationSelect = <Select
    aria-label={hasEntities ? 'Administratie kiezen' : 'Organisatie kiezen'}
    value={activeOrganizationId ?? ''}
    onChange={event => onOrganization(event.target.value)}
  >
    {organizationGroups.map(group => group.children.length === 0
      ? <option key={group.root.id} value={group.root.id}>{group.root.name}</option>
      : <optgroup key={group.root.id} label={group.root.name}>
          <option value={group.root.id}>{group.root.name}</option>
          {group.children.map(child => <option key={child.id} value={child.id}>{child.name}</option>)}
        </optgroup>)}
  </Select>;

  return <aside className={`sidebar${mobileOpen ? ' is-open' : ''}${userMenuOpen ? ' user-open' : ''}`}>
    <div className="sidebar-head">
      <button type="button" className="sidebar-close" onClick={onCloseMobile} aria-label="Menu sluiten"><X size={20}/></button>
      {onRefresh && <button type="button" className={`sidebar-refresh${refreshing ? ' is-busy' : ''}`} onClick={onRefresh} disabled={refreshing} aria-label="Gegevens verversen" title="Verversen"><RefreshCw size={17}/></button>}
      <button type="button" className="sidebar-pin" onClick={onTogglePin} aria-pressed={pinned} aria-label={pinned ? 'Menu losmaken' : 'Menu vastzetten'} title={pinned ? 'Menu losmaken' : 'Menu vastzetten'}>{pinned ? <PinOff size={15}/> : <Pin size={15}/>}</button>
      <div className="app-brand"><div className="brand-icon"><BrandMark /></div><span>ResoFly<small>{standaloneApp?.shortName ?? 'Werkruimte'}</small></span></div>
      <div className="org-switcher">
        <label>{hasEntities ? 'Administratie' : 'Organisatie'}</label>
        {organizationSelect}
        {readOnly && <div className="sidebar-readonly"><Lock size={12} aria-hidden="true"/><span>Alleen lezen op deze pagina</span></div>}
        <div className="org-meta">
          <span>{roleLabel}</span>
          {onNewEntity && <button onClick={onNewEntity}>+ administratie</button>}
          <button onClick={onNewOrganization}>+ organisatie</button>
        </div>
      </div>
    </div>
    <nav className="sidebar-nav">
      <GlobalSearch data={data} onNavigate={onSearchNavigate} canOpenPage={permissions.canOpenPage} />
      {navGroups.map(group => {
        const visibleItems = group.items.filter(([key]) => canOpenNavItem(key, permissions));
        if (visibleItems.length === 0) return null;

        return <Fragment key={group.id}>
        <div className="nav-section nav-group"><span>{group.label}</span></div>
        {visibleItems.map(([key, Icon, label]) => {
        const isProjectsActive = key === 'projects' && projectPages.includes(page);
        const isCalendarActive = key === 'calendar' && calendarPages.includes(page);
        const isFinanceActive = key === 'finance' && financePages.includes(page);
        const isContentActive = key === 'content' && contentPages.includes(page);
        const isReportsActive = key === 'stats' && reportPages.includes(page);
        const isActive = key === page || isProjectsActive || isCalendarActive || isFinanceActive || isContentActive || isReportsActive;
        const reportMenu = key === 'stats' && aiReports.length > 0 && Boolean(onOpenAiReport);

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
                {/* Dichtgeklapt draagt de ouder de teller, zodat hij niet uit beeld valt. */}
                {!financeOpen && purchaseInboxOpen > 0 && <span className="nav-badge" title={purchaseInboxTitle}>{purchaseInboxOpen > 99 ? '99+' : purchaseInboxOpen}</span>}
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
            : reportMenu
              ? <button
                  type="button"
                  className={`nav-item nav-item-parent ${isActive ? 'active' : ''}`}
                  aria-expanded={reportsOpen}
                  onClick={() => setReportsOpen(open => !open)}
                >
                  <Icon size={16}/>
                  <span className="ni-label">{label}</span>
                  <span className="nav-chevron" aria-hidden="true">{reportsOpen ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</span>
                </button>
            : key === 'calendar'
              ? <button
                  type="button"
                  className={`nav-item nav-item-parent ${isActive ? 'active' : ''}`}
                  aria-expanded={calendarOpen}
                  onClick={() => setCalendarOpen(open => !open)}
                >
                  <Icon size={16}/>
                  <span className="ni-label">{label}</span>
                  <span className="nav-chevron" aria-hidden="true">{calendarOpen ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</span>
                </button>
              : <button className={`nav-item ${isActive ? 'active' : ''}`} onClick={() => onPage(key as Page)}><Icon size={16}/><span className="ni-label">{label}</span>{key === 'communication' && messageBadge > 0 && <span className="nav-badge" title={messageBadgeTitle}>{messageBadge > 99 ? '99+' : messageBadge}</span>}{key === 'tickets' && ticketUnread > 0 && <span className="nav-badge" title={`${ticketUnread} ticket${ticketUnread === 1 ? '' : 's'} met nieuwe klant-activiteit`}>{ticketUnread > 99 ? '99+' : ticketUnread}</span>}{key === 'chat' && chatUnread > 0 && <span className="nav-badge" title={`${chatUnread} ongelezen chatbericht${chatUnread === 1 ? '' : 'en'}`}>{chatUnread > 99 ? '99+' : chatUnread}</span>}{key === 'gerrie' && decisionCount > 0 && <span className="nav-badge" title={`${decisionCount} kaart${decisionCount === 1 ? '' : 'en'} te beslissen`}>{decisionCount > 99 ? '99+' : decisionCount}</span>}</button>}

          {reportMenu && reportsOpen && <div className="nav-submenu nav-submenu-projects nav-submenu-reports">
            <button type="button" className={page === 'stats' ? 'active' : ''} onClick={() => onPage('stats')}><BarChart3 size={13}/><span>Alle rapportages</span></button>
            {aiReports.slice(0, MENU_REPORTS).map(report => (
              <button key={report.id} type="button" className={page === 'report' && activeAiReportId === report.id ? 'active' : ''} onClick={() => onOpenAiReport?.(report.id)} title={buildingReports.has(report.id) ? `${report.title} — Gerrie is bezig` : report.title} aria-label={buildingReports.has(report.id) ? `${report.title}, Gerrie is bezig` : undefined}>
                <FileText size={13}/><span>{report.title}</span>
                {buildingReports.has(report.id) && <span className="aire-nav-live" aria-hidden="true" />}
              </button>
            ))}
          </div>}

          {key === 'calendar' && calendarOpen && <div className="nav-submenu nav-submenu-projects">
            {permissions.canOpenPage('calendar') && <button type="button" className={page === 'calendar' ? 'active' : ''} onClick={openCalendarView}><Calendar size={13}/><span>Agendaweergave</span></button>}
            {permissions.canOpenPage('meeting-booking') && <button type="button" className={page === 'meeting-booking' ? 'active' : ''} onClick={() => openCalendarPage('meeting-booking')}><CalendarClock size={13}/><span>Boekingslinks</span></button>}
          </div>}

          {key === 'projects' && projectsOpen && <div className="nav-submenu nav-submenu-projects">
            <button type="button" className={page === 'projects' || page === 'project' ? 'active' : ''} onClick={() => openProjectPage('projects')}><FolderOpen size={13}/><span>Projectoverzicht</span></button>
            {permissions.canOpenPage('weekplanner') && <button type="button" className={page === 'weekplanner' ? 'active' : ''} onClick={() => openProjectPage('weekplanner')}><CalendarRange size={13}/><span>Weekplanner</span></button>}
            <button type="button" className={page === 'project-planning' ? 'active' : ''} onClick={() => openProjectPage('project-planning')}><Calendar size={13}/><span>Planningstimeline</span></button>
            <button type="button" className={page === 'archive' ? 'active' : ''} onClick={() => openProjectPage('archive')}><Archive size={13}/><span>Archief</span></button>
          </div>}

          {key === 'finance' && financeOpen && <div className="nav-submenu nav-submenu-finance">
            <button type="button" className={page === 'quotes' ? 'active' : ''} onClick={() => openFinancePage('quotes')}><FileText size={13}/><span>Offertes</span></button>
            <button type="button" className={page === 'contracts' ? 'active' : ''} onClick={() => openFinancePage('contracts')}><FileSignature size={13}/><span>Contracten</span></button>
            <button type="button" className={page === 'invoices' ? 'active' : ''} onClick={() => openFinancePage('invoices')}><Receipt size={13}/><span>Facturen</span></button>
            <button type="button" className={page === 'suppliers' ? 'active' : ''} onClick={() => openFinancePage('suppliers')}><Truck size={13}/><span>Leveranciers</span></button>
            <button type="button" className={page === 'purchase-invoices' ? 'active' : ''} onClick={() => openFinancePage('purchase-invoices')}><FileText size={13}/><span>Inkoopfacturen</span>{purchaseInboxOpen > 0 && <span className="nav-badge nav-sub-badge" title={purchaseInboxTitle}>{purchaseInboxOpen > 99 ? '99+' : purchaseInboxOpen}</span>}</button>
            <button type="button" className={page === 'ledger' ? 'active' : ''} onClick={() => openFinancePage('ledger')}><BookOpen size={13}/><span>Grootboek</span></button>
            <button type="button" className={page === 'bank' ? 'active' : ''} onClick={() => openFinancePage('bank')}><Landmark size={13}/><span>Bank</span></button>
            <button type="button" className={page === 'assets' ? 'active' : ''} onClick={() => openFinancePage('assets')}><Boxes size={13}/><span>Activa</span></button>
            <button type="button" className={page === 'prepaid' ? 'active' : ''} onClick={() => openFinancePage('prepaid')}><Hourglass size={13}/><span>Vooruitbetaald</span></button>
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
            {/* Eenmanszaak, vof, maatschap en cv: de winst is van de ondernemer of
                de vennoten zelf; daar horen het privé en de kapitaalvergelijking
                bij (bij een vof per vennoot). */}
            {['eenmanszaak', 'vof', 'maatschap', 'cv'].includes(data.companySettings?.legal_form ?? 'eenmanszaak') && (
              <button type="button" className={page === 'owners' ? 'active' : ''} onClick={() => openFinancePage('owners')}><Wallet size={13}/><span>{['vof', 'maatschap', 'cv'].includes(data.companySettings?.legal_form ?? 'eenmanszaak') ? 'Vennoten' : 'Eigen vermogen'}</span></button>
            )}
            <button type="button" className={page === 'fiscal-years' ? 'active' : ''} onClick={() => openFinancePage('fiscal-years')}><CalendarClock size={13}/><span>Boekjaren</span></button>
            {/* Een jaarrekening volgens Titel 9 Boek 2 BW hoort bij een BV, NV of
                coöperatie; een eenmanszaak maakt er geen op en deponeert niets. */}
            {['bv', 'nv', 'cooperatie'].includes(data.companySettings?.legal_form ?? 'eenmanszaak') && (
              <button type="button" className={page === 'annual-accounts' ? 'active' : ''} onClick={() => openFinancePage('annual-accounts')}><Scale size={13}/><span>Jaarrekening</span></button>
            )}
          </div>}
        </div>;
        })}
        </Fragment>;
      })}
      {onOpenWorkspace && <>
        <div className="nav-workspace-sep" aria-hidden="true" />
        <div className="nav-item-wrap">
          <button type="button" className="nav-item nav-workspace" onClick={onOpenWorkspace} title="De hele werkruimte openen">
            <ExternalLink size={16}/><span className="ni-label">Volledige werkruimte</span>
          </button>
        </div>
      </>}
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
        <div className="user-menu-section">Weergave</div>
        <div className="theme-switch" role="group" aria-label="Thema">
          <button
            type="button"
            className={theme === 'dark' ? 'is-on' : undefined}
            aria-pressed={theme === 'dark'}
            onClick={() => setTheme('dark')}
          >
            <Moon size={14}/><span>Donker</span>
          </button>
          <button
            type="button"
            className={theme === 'light' ? 'is-on' : undefined}
            aria-pressed={theme === 'light'}
            onClick={() => setTheme('light')}
          >
            <Sun size={14}/><span>Licht</span>
          </button>
        </div>
        {/* De look: Baken is de standaard; Cockpit, Zenit (DESIGN_VOORSTEL_ZENIT_
            2026-10-22.md) en Stroom (DESIGN_VOORSTEL_STROOM_2026-10-30.md)
            blijven kiesbaar, per browser. In Baken, Zenit en Stroom staat
            dezelfde keuze onder Weergave → Look in de rail. */}
        <div className="look-switch" role="group" aria-label="Look">
          {LOOK_CHOICES.map(option => <button
            key={option.look}
            type="button"
            className={`look-option${look === option.look ? ' is-on' : ''}`}
            aria-pressed={look === option.look}
            onClick={() => { setUserMenuOpen(false); if (look !== option.look) setLook(option.look); }}
          >
            <span className={`look-sw is-${option.look}`} aria-hidden="true"/>
            <span className="look-t"><b>{option.label}</b><small>{option.hint}</small></span>
          </button>)}
        </div>
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
          <span className="user-role">{roleLabel}</span>
        </span>
        <ChevronUp size={16} className="user-caret" aria-hidden="true"/>
      </button>
    </div>
  </aside>;
}
