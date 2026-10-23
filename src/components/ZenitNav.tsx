import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Archive, BarChart3, BookOpen, BookUser, Boxes, Building2, Calendar, CalendarClock, CalendarRange, Clock, FileSignature, FileText, FolderKanban, FolderOpen, GanttChart, Inbox, Landmark, LayoutDashboard, Library, Lock, LogOut, Megaphone, MessageSquare, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Percent, Plus, Receipt, RefreshCw, Scale, Settings, Sparkles, Sun, SunMoon, Sunrise, Ticket, TrendingUp, Truck, Users, Wallet, X, type LucideIcon } from 'lucide-react';
import { Select } from './Ui';
import { askGerrie } from './GerrieChat';
import { visibleSettingsTabs, type Page, type SidebarProps } from './Sidebar';
import { FULL_PERMISSIONS, isAccountantRole, type Permissions } from '../lib/permissions';
import { useThemeMode, type ThemeMode } from '../lib/theme';
import { useLook } from '../lib/look';
import { formatClock, sunTimes } from '../lib/sun';
import { useNarrowViewport } from '../lib/useNarrowViewport';

/**
 * De navigatie van Zenit (designvoorstel 2026-10-22): een smalle nachtrail met
 * zeven modules en daarnaast een contextpaneel met wat je ín die module kunt.
 *
 * Zelfde gegevens en dezelfde regels als de zijbalk van Cockpit (Sidebar.tsx):
 * modulerechten, de rechtsvorm (vennootschapsbelasting, DGA, aandeelhouders,
 * jaarrekening) en de tellers. Alleen de indeling is anders: dertien regels
 * onder elkaar worden zeven plekken, en elke plek toont pas zijn submenu als je
 * er bent.
 *
 * Desktop (≥761px): vastgezet staan rail en paneel naast het werkvlak; los
 * staat alleen de rail en schuift het paneel bij hover of focus over het
 * werkvlak. Telefoon: één uitschuifmenu met de rail links en het paneel rechts;
 * een tik op de rail wisselt het paneel, een tik in het paneel navigeert.
 */

type ModuleId = 'vandaag' | 'gerrie' | 'agenda' | 'werk' | 'geld' | 'berichten' | 'inzicht';

interface NavItem {
  page: Page;
  label: string;
  Icon: LucideIcon;
  /** Andere pagina's waarop deze regel oplicht: een geopend project hoort bij Projecten. */
  also?: Page[];
  badge?: number;
  badgeTitle?: string;
}
interface NavGroup { label?: string; items: NavItem[] }
interface ModuleDef {
  id: ModuleId;
  label: string;
  Icon: LucideIcon;
  /** Waar een klik op de rail heen gaat: de eerste die openstaat. */
  home: Page[];
  groups: NavGroup[];
  badge: number;
  badgeTitle?: string;
}

const FINANCE_PAGES: Page[] = ['quotes', 'contracts', 'invoices', 'suppliers', 'purchase-invoices', 'ledger', 'bank', 'assets', 'pnl', 'vat-returns', 'corporate-tax', 'dga', 'shareholders', 'fiscal-years', 'annual-accounts'];

/** Bij welke module hoort een pagina? Ook pagina's zonder eigen menuregel
 *  (een klant, een project, een galerij) lichten zo de goede plek op. */
const MODULE_PAGES: Record<ModuleId, Page[]> = {
  vandaag: ['dashboard'],
  gerrie: ['gerrie'],
  agenda: ['calendar', 'meeting-booking', 'weekplanner', 'time'],
  werk: ['clients', 'client', 'projects', 'project', 'gallery', 'project-planning', 'tickets', 'archive'],
  geld: FINANCE_PAGES,
  berichten: ['communication', 'chat', 'marketing'],
  inzicht: ['stats', 'content', 'notes', 'documents'],
};

function moduleOfPage(page: Page): ModuleId | null {
  for (const id of Object.keys(MODULE_PAGES) as ModuleId[]) {
    if (MODULE_PAGES[id].includes(page)) return id;
  }
  return null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const badgeText = (n: number) => (n > 99 ? '99+' : String(n));

function buildModules({ permissions, legalForm, decisionCount, ticketUnread, purchaseInboxOpen, messageUnread, inboxOpen, chatUnread }: {
  permissions: Permissions;
  legalForm: string;
  decisionCount: number;
  ticketUnread: number;
  purchaseInboxOpen: number;
  messageUnread: number;
  inboxOpen: number;
  chatUnread: number;
}): ModuleDef[] {
  const can = (page: Page) => permissions.canOpenPage(page);
  const keep = (items: (NavItem | false)[]) => items.filter((item): item is NavItem => item !== false && can(item.page));
  // Zelfde regels als de zijbalk: alleen wat bij deze rechtsvorm bestaat.
  const isCompany = ['bv', 'nv', 'cooperatie'].includes(legalForm);
  const hasShares = ['bv', 'nv'].includes(legalForm);
  const messageBadge = messageUnread + inboxOpen;
  const messageTitle = [
    messageUnread > 0 ? plural(messageUnread, 'ongelezen bericht', 'ongelezen berichten') : '',
    inboxOpen > 0 ? `${plural(inboxOpen, 'bericht', 'berichten')} nog niet aan een klant gekoppeld` : '',
  ].filter(Boolean).join(' · ');
  const decisionTitle = `${plural(decisionCount, 'kaart', 'kaarten')} te beslissen`;
  const ticketTitle = `${plural(ticketUnread, 'ticket', 'tickets')} met nieuwe klant-activiteit`;
  const purchaseTitle = `${plural(purchaseInboxOpen, 'per e-mail binnengekomen inkoopfactuur', 'per e-mail binnengekomen inkoopfacturen')} met aandacht nodig`;
  const chatTitle = plural(chatUnread, 'ongelezen chatbericht', 'ongelezen chatberichten');

  const modules: ModuleDef[] = [
    { id: 'vandaag', label: 'Vandaag', Icon: Sunrise, home: ['dashboard'], badge: 0, groups: [{ items: keep([
      { page: 'dashboard', label: 'Overzicht', Icon: LayoutDashboard },
      { page: 'gerrie', label: 'Te beslissen', Icon: Sparkles, badge: decisionCount, badgeTitle: decisionTitle },
      { page: 'weekplanner', label: 'Mijn week', Icon: CalendarRange },
    ]) }] },
    { id: 'gerrie', label: 'Gerrie', Icon: Sparkles, home: ['gerrie'], badge: decisionCount, badgeTitle: decisionTitle, groups: [{ items: keep([
      { page: 'gerrie', label: 'Beslissingen en agents', Icon: Sparkles, badge: decisionCount, badgeTitle: decisionTitle },
    ]) }] },
    { id: 'agenda', label: 'Agenda', Icon: Calendar, home: ['calendar', 'weekplanner', 'meeting-booking', 'time'], badge: 0, groups: [{ items: keep([
      { page: 'calendar', label: 'Agendaweergave', Icon: Calendar },
      { page: 'weekplanner', label: 'Weekplanner', Icon: CalendarRange },
      { page: 'meeting-booking', label: 'Boekingslinks', Icon: CalendarClock },
      { page: 'time', label: 'Uren', Icon: Clock },
    ]) }] },
    { id: 'werk', label: 'Werk', Icon: FolderKanban, home: ['clients', 'projects', 'tickets', 'project-planning', 'archive'], badge: ticketUnread, badgeTitle: ticketTitle, groups: [{ items: keep([
      { page: 'clients', label: 'Klanten', Icon: Users, also: ['client'] },
      { page: 'projects', label: 'Projecten', Icon: FolderOpen, also: ['project', 'gallery'] },
      { page: 'project-planning', label: 'Planningstimeline', Icon: GanttChart },
      { page: 'tickets', label: 'Tickets', Icon: Ticket, badge: ticketUnread, badgeTitle: ticketTitle },
      { page: 'archive', label: 'Archief', Icon: Archive },
    ]) }] },
    { id: 'geld', label: 'Geld', Icon: Wallet, home: ['invoices', ...FINANCE_PAGES], badge: purchaseInboxOpen, badgeTitle: purchaseTitle, groups: [
      { label: 'Verkoop', items: keep([
        { page: 'quotes', label: 'Offertes', Icon: FileText },
        { page: 'contracts', label: 'Contracten', Icon: FileSignature },
        { page: 'invoices', label: 'Facturen', Icon: Receipt },
      ]) },
      { label: 'Inkoop', items: keep([
        { page: 'suppliers', label: 'Leveranciers', Icon: Truck },
        { page: 'purchase-invoices', label: 'Inkoopfacturen', Icon: Inbox, badge: purchaseInboxOpen, badgeTitle: purchaseTitle },
      ]) },
      { label: 'Boekhouding', items: keep([
        { page: 'bank', label: 'Bank', Icon: Landmark },
        { page: 'ledger', label: 'Grootboek', Icon: BookOpen },
        { page: 'assets', label: 'Activa', Icon: Boxes },
        { page: 'fiscal-years', label: 'Boekjaren', Icon: CalendarClock },
      ]) },
      { label: 'Rapportage', items: keep([
        { page: 'pnl', label: 'Winst & verlies', Icon: TrendingUp },
        { page: 'vat-returns', label: 'Omzetbelasting', Icon: Percent },
        isCompany && { page: 'corporate-tax', label: 'Vennootschapsbelasting', Icon: Landmark },
        hasShares && { page: 'dga', label: 'DGA', Icon: Users },
        hasShares && { page: 'shareholders', label: 'Aandeelhouders', Icon: BookUser },
        isCompany && { page: 'annual-accounts', label: 'Jaarrekening', Icon: Scale },
      ]) },
    ] },
    { id: 'berichten', label: 'Berichten', Icon: Inbox, home: ['communication', 'chat', 'marketing'], badge: messageBadge + chatUnread, badgeTitle: [messageTitle, chatUnread > 0 ? chatTitle : ''].filter(Boolean).join(' · '), groups: [{ items: keep([
      { page: 'communication', label: 'Postvak', Icon: Inbox, badge: messageBadge, badgeTitle: messageTitle },
      { page: 'chat', label: 'Chat', Icon: MessageSquare, badge: chatUnread, badgeTitle: chatTitle },
      { page: 'marketing', label: 'Marketing', Icon: Megaphone },
    ]) }] },
    { id: 'inzicht', label: 'Inzicht', Icon: BarChart3, home: ['stats', 'content'], badge: 0, groups: [{ items: keep([
      { page: 'stats', label: 'Statistieken', Icon: BarChart3 },
      { page: 'content', label: 'Inhoud', Icon: Library, also: ['notes', 'documents'] },
    ]) }] },
  ];
  // Een module waarvan elk onderdeel dichtstaat, verdwijnt van de rail.
  return modules
    .map(module => ({ ...module, groups: module.groups.filter(group => group.items.length > 0) }))
    .filter(module => module.groups.length > 0);
}

/** Klikken buiten het venster of Escape sluit het; Escape zet de focus terug
 *  op de knop die het opende (menu-button-patroon). */
function usePopover() {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (boxRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onPointer); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return { open, setOpen, boxRef, triggerRef };
}

/** Pijltjes omhoog en omlaag in een menu, zoals in elk menu van het besturingssysteem. */
function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled)'));
  if (items.length === 0) return;
  event.preventDefault();
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? items.length - 1
    : event.key === 'ArrowDown' ? (index + 1) % items.length
    : (index - 1 + items.length) % items.length;
  items[next]?.focus();
}

/** De nieuwe dag (of nacht) groeit als een cirkel vanuit de knop waarop je
 *  klikte. Zonder View Transitions, of met minder beweging, wisselt het meteen. */
function withThemeReveal(origin: HTMLElement | null, apply: () => void) {
  const doc = document as Document & { startViewTransition?: (update: () => void) => { ready: Promise<void> } };
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!doc.startViewTransition || reduced || !origin) { apply(); return; }
  const box = origin.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  const transition = doc.startViewTransition(() => flushSync(apply));
  transition.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 620, easing: 'cubic-bezier(.16,1,.3,1)', pseudoElement: '::view-transition-new(root)' },
    );
  }).catch(() => { /* overgeslagen overgang: het thema staat er al */ });
}

const THEME_OPTIONS: { mode: ThemeMode; label: string; Icon: LucideIcon; swatch: string }[] = [
  { mode: 'dark', label: 'Nacht', Icon: Moon, swatch: 'nacht' },
  { mode: 'light', label: 'Dag', Icon: Sun, swatch: 'dag' },
  { mode: 'sun', label: 'Met de zon mee', Icon: Sunrise, swatch: 'zon' },
  { mode: 'system', label: 'Systeem', Icon: Monitor, swatch: 'sys' },
];

function initialsOf(text: string): string {
  const parts = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (parts.length === 0) return '?';
  const letters = parts.length >= 2 ? `${parts[0][0]}${parts[1][0]}` : parts[0].slice(0, 2);
  return letters.toUpperCase();
}

export function ZenitNav({
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
}: SidebarProps) {
  const narrow = useNarrowViewport();
  const [themeMode, setThemeMode, theme] = useThemeMode();
  const [, setLook] = useLook();
  const view = usePopover();
  const account = usePopover();

  const modules = useMemo(() => buildModules({
    permissions,
    legalForm: data.companySettings?.legal_form ?? 'eenmanszaak',
    decisionCount, ticketUnread, purchaseInboxOpen, messageUnread, inboxOpen, chatUnread,
  }), [permissions, data.companySettings?.legal_form, decisionCount, ticketUnread, purchaseInboxOpen, messageUnread, inboxOpen, chatUnread]);

  const activeModuleId = moduleOfPage(page);
  // Op de telefoon wisselt een tik op de rail alleen het paneel; navigeren doe
  // je in het paneel. Terug naar de module van de pagina zodra die verandert of
  // het menu dichtgaat.
  const [shownModuleId, setShownModuleId] = useState<ModuleId | null>(activeModuleId);
  useEffect(() => { setShownModuleId(activeModuleId); }, [activeModuleId, mobileOpen]);
  const shownModule = modules.find(module => module.id === shownModuleId)
    ?? modules.find(module => module.id === activeModuleId)
    ?? modules[0];

  const settingsTabs = visibleSettingsTabs(activeRole, permissions);
  const roleLabel = isAccountantRole(activeRole) ? 'boekhouder' : activeRole ?? 'geen rol';
  const accountName = (userEmail ?? '').split('@')[0] || 'Account';
  const accountInitials = userEmail ? initialsOf((userEmail.split('@')[0] || userEmail)) : '?';
  const activeOrganization = organizations.find(org => org.id === activeOrganizationId) ?? null;
  const sun = sunTimes(new Date());

  // Administraties onder hun moeder (holding + werk-BV), als één platte lijst:
  // "Holding › Werk BV". Een administratie waarvan de moeder niet zichtbaar is,
  // staat gewoon op het eerste niveau.
  const visibleIds = new Set(organizations.map(org => org.id));
  const organizationOptions = organizations
    .filter(org => !org.parent_organization_id || !visibleIds.has(org.parent_organization_id))
    .flatMap(root => [
      { id: root.id, label: root.name },
      ...organizations.filter(org => org.parent_organization_id === root.id).map(child => ({ id: child.id, label: `${root.name} › ${child.name}` })),
    ]);
  const hasEntities = organizations.some(org => org.parent_organization_id && visibleIds.has(org.parent_organization_id));

  const recentProjects = useMemo(() => permissions.canOpenPage('project')
    ? data.projects.filter(project => !project.archived).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 5)
    : [], [data.projects, permissions]);

  function go(target: Page) {
    if (target === 'calendar') {
      // Zelfde als de zijbalk: naar de agenda én naar het rooster scrollen.
      onPage('calendar');
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#calendar-agenda`);
      window.setTimeout(() => window.dispatchEvent(new CustomEvent('brandcore:calendar-anchor', { detail: { anchor: 'agenda' } })), 80);
      return;
    }
    onPage(target);
  }

  // Na een klik in het paneel de focus loslaten, net als bij navigeren (main.tsx):
  // anders houdt :focus-within het losse paneel open nadat je al verder bent.
  function letGo() {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  function openModule(module: ModuleDef) {
    if (narrow) { setShownModuleId(module.id); return; }
    const home = module.home.find(target => permissions.canOpenPage(target)) ?? module.groups[0]?.items[0]?.page;
    if (home) go(home);
  }

  function chooseTheme(mode: ThemeMode, origin: HTMLElement) {
    if (mode === themeMode) return;
    withThemeReveal(origin, () => setThemeMode(mode));
  }

  const isItemActive = (item: NavItem) => item.page === page || (item.also?.includes(page) ?? false);
  const railSeparatorBefore = new Set<ModuleId>(['agenda', 'berichten']);

  // Instellingen hebben geen plek op de rail (alleen het tandwiel onderin);
  // daar toont het paneel de onderdelen van de instellingen zelf. Tik je op de
  // telefoon een module aan, dan wint die.
  const showSettingsPanel = page === 'settings' && shownModuleId === null;
  const panelTitle = showSettingsPanel ? 'Instellingen' : shownModule?.label ?? 'Menu';

  let panelBody: ReactNode = showSettingsPanel
    ? <div className="zpnav-group"><div className="zpnav">
        {settingsTabs.map(tab => <button
          type="button"
          key={tab.id}
          className="zpnav-item"
          onClick={() => { onOpenSettings(tab.id); letGo(); }}
        ><tab.Icon size={16} aria-hidden="true"/><span className="zpnav-l">{tab.label}</span></button>)}
      </div></div>
    : shownModule
    ? shownModule.groups.map((group, index) => <div className="zpnav-group" key={group.label ?? index}>
        {group.label && <div className="zpnav-h">{group.label}</div>}
        <div className="zpnav">
          {group.items.map(item => {
            const active = isItemActive(item);
            return <button
              type="button"
              key={item.page}
              className={`zpnav-item${active ? ' is-on' : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => go(item.page)}
            >
              <item.Icon size={16} aria-hidden="true"/>
              <span className="zpnav-l">{item.label}</span>
              {item.badge != null && item.badge > 0 && <span className="zpnav-n" title={item.badgeTitle}>{badgeText(item.badge)}</span>}
            </button>;
          })}
        </div>
      </div>)
    : null;
  if (!showSettingsPanel && shownModule?.id === 'gerrie') {
    panelBody = <>
      {panelBody}
      <div className="zpnav-group">
        <div className="zpnav-h">Gesprek</div>
        <div className="zpnav">
          <button type="button" className="zpnav-item" onClick={() => { onCloseMobile?.(); letGo(); askGerrie(); }}>
            <MessageSquare size={16} aria-hidden="true"/><span className="zpnav-l">Praat met Gerrie</span>
          </button>
        </div>
      </div>
    </>;
  }
  if (!showSettingsPanel && shownModule && (shownModule.id === 'werk' || shownModule.id === 'vandaag') && recentProjects.length > 0) {
    panelBody = <>
      {panelBody}
      <div className="zpnav-group">
        <div className="zpnav-h">Recent bijgewerkt</div>
        <div className="zpnav">
          {recentProjects.map(project => <button
            type="button"
            key={project.id}
            className="zpnav-item zpnav-project"
            onClick={() => { onSearchNavigate({ kind: 'project', id: project.id, title: project.name, subtitle: '', item: project }); onCloseMobile?.(); letGo(); }}
          >
            <span className="zpnav-dot" style={{ background: project.color }} aria-hidden="true"/>
            <span className="zpnav-l">{project.name}</span>
          </button>)}
        </div>
      </div>
    </>;
  }

  const showGerrieCard = permissions.canOpenPage('gerrie');

  return <aside
    className={`znav${mobileOpen ? ' is-open' : ''}${view.open || account.open ? ' has-pop' : ''}`}
    aria-label="Navigatie"
  >
    <nav className="zrail cmd-scope" aria-label="Modules">
      <button type="button" className="zrail-logo" onClick={() => go('dashboard')} aria-label="ResoFly, naar Vandaag" title="ResoFly">R</button>
      {modules.map(module => {
        const on = module.id === activeModuleId;
        const shown = narrow && module.id === shownModule?.id;
        return <div className="zrail-slot" key={module.id}>
          {railSeparatorBefore.has(module.id) && <span className="zrail-sep" aria-hidden="true"/>}
          <button
            type="button"
            className={`zrail-btn${on ? ' is-on' : ''}${shown ? ' is-shown' : ''}${module.id === 'gerrie' ? ' is-ai' : ''}`}
            aria-current={on ? 'page' : undefined}
            aria-label={module.badge > 0 ? `${module.label}, ${module.badgeTitle}` : module.label}
            onClick={() => openModule(module)}
          >
            <module.Icon size={21} strokeWidth={1.6} aria-hidden="true"/>
            {module.badge > 0 && <span className="zrail-count" aria-hidden="true">{badgeText(module.badge)}</span>}
            <span className="ztip" aria-hidden="true">{module.label}</span>
          </button>
        </div>;
      })}
      <div className="zrail-foot">
        <button
          ref={view.triggerRef}
          type="button"
          className={`zrail-btn${view.open ? ' is-shown' : ''}`}
          aria-label="Weergave"
          aria-haspopup="dialog"
          aria-expanded={view.open}
          onClick={() => { account.setOpen(false); view.setOpen(open => !open); }}
        >
          <SunMoon size={20} strokeWidth={1.6} aria-hidden="true"/>
          <span className="ztip" aria-hidden="true">Weergave</span>
        </button>
        <button
          type="button"
          className={`zrail-btn${page === 'settings' ? ' is-on' : ''}`}
          aria-label="Instellingen"
          aria-current={page === 'settings' ? 'page' : undefined}
          onClick={() => onOpenSettings()}
        >
          <Settings size={20} strokeWidth={1.6} aria-hidden="true"/>
          <span className="ztip" aria-hidden="true">Instellingen</span>
        </button>
        <button
          ref={account.triggerRef}
          type="button"
          className={`zrail-me${account.open ? ' is-open' : ''}`}
          aria-label={`${accountName}, account`}
          aria-haspopup="menu"
          aria-expanded={account.open}
          onClick={() => { view.setOpen(false); account.setOpen(open => !open); }}
        >{accountInitials}</button>
      </div>
    </nav>

    <div className="zpanel">
      <div className="zpanel-top">
        <div className="zorg">
          <span className="zorg-tile" aria-hidden="true">{activeOrganization ? initialsOf(activeOrganization.name) : <Building2 size={15}/>}</span>
          <div className="zorg-n">
            <Select
              value={activeOrganizationId ?? ''}
              onChange={event => onOrganization(event.target.value)}
              aria-label={hasEntities ? 'Administratie' : 'Organisatie'}
              menuMinWidth={240}
            >
              {organizationOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
            </Select>
            <span className="zorg-role">{roleLabel}</span>
          </div>
        </div>
        <button type="button" className="zpanel-close" onClick={onCloseMobile} aria-label="Menu sluiten"><X size={20}/></button>
      </div>

      <div className="zmod-h">
        <h2>{panelTitle}</h2>
        <div className="zmod-acts">
          {onRefresh && <button type="button" className={`zicon-btn${refreshing ? ' is-busy' : ''}`} onClick={onRefresh} disabled={refreshing} aria-label="Gegevens verversen" title="Verversen"><RefreshCw size={15}/></button>}
          {onTogglePin && <button type="button" className="zicon-btn zpin" onClick={event => { onTogglePin(); if (event.detail > 0) event.currentTarget.blur(); }} aria-pressed={pinned} aria-label={pinned ? 'Paneel inklappen' : 'Paneel vastzetten'} title={pinned ? 'Paneel inklappen' : 'Paneel vastzetten'}>{pinned ? <PanelLeftClose size={16}/> : <PanelLeftOpen size={16}/>}</button>}
        </div>
      </div>
      {/* Op de telefoon is er geen tabrij met "Alleen lezen"; dan staat het hier. */}
      {readOnly && <div className="zreadonly"><Lock size={12} aria-hidden="true"/><span>Alleen lezen op deze pagina</span></div>}

      <nav className="zpanel-scroll" aria-label={panelTitle}>{panelBody}</nav>

      {showGerrieCard && <button type="button" className="zpanel-foot" onClick={() => go('gerrie')}>
        <span className="zorb sm live" aria-hidden="true"/>
        <b>{decisionCount > 0 ? plural(decisionCount, 'voorstel wacht', 'voorstellen wachten') : 'Gerrie waakt'}</b>
        <span className="zpanel-foot-t">{decisionCount > 0 ? 'Bekijk en beslis in één klik' : 'Niets dat op je wacht'}</span>
      </button>}
    </div>

    {view.open && <div ref={view.boxRef} className="zpop" role="dialog" aria-label="Weergave" onKeyDown={onMenuKeyDown}>
      <div className="zpop-h">Thema</div>
      <div className="zpop-themes" role="group" aria-label="Thema">
        {THEME_OPTIONS.map(option => <button
          type="button"
          key={option.mode}
          aria-pressed={themeMode === option.mode}
          className="zth"
          onClick={event => chooseTheme(option.mode, event.currentTarget)}
        >
          <span className={`zth-sw ${option.swatch}`} aria-hidden="true"/>
          <span className="zth-l"><option.Icon size={13} aria-hidden="true"/>{option.label}</span>
          {option.mode === 'sun' && <small>op {formatClock(sun.rise)} · onder {formatClock(sun.set)}</small>}
          {option.mode === 'system' && <small>volgt je apparaat</small>}
          {option.mode === 'dark' && <small>de standaard</small>}
          {option.mode === 'light' && <small>papier op steen</small>}
        </button>)}
      </div>
      {(themeMode === 'sun' || themeMode === 'system') && <p className="zpop-note">Nu {theme === 'light' ? 'Dag' : 'Nacht'}{themeMode === 'sun' ? `, tot zon ${theme === 'light' ? 'onder' : 'op'}` : ''}.</p>}
      <div className="zpop-sep" aria-hidden="true"/>
      <div className="zpop-row">
        <span className="zpop-row-t"><b>Zenit</b><small>De nieuwe voorkant. Uit = de vertrouwde look.</small></span>
        <button type="button" role="switch" aria-checked="true" className="zswitch" onClick={() => { view.setOpen(false); setLook('cockpit'); }} aria-label="Zenit uitzetten"><span aria-hidden="true"/></button>
      </div>
    </div>}

    {account.open && <div ref={account.boxRef} className="zpop zpop-account" role="menu" aria-label="Account en instellingen" onKeyDown={onMenuKeyDown}>
      <div className="zpop-who">
        <span className="zav" aria-hidden="true">{accountInitials}</span>
        <span className="zpop-who-t"><b>{accountName}</b><span title={userEmail ?? undefined}>{userEmail ?? 'Onbekend account'}</span></span>
      </div>
      <div className="zpop-h">Instellingen</div>
      <div className="zpop-list">
        {settingsTabs.map(tab => <button
          key={tab.id}
          type="button"
          role="menuitem"
          className="zpop-item"
          onClick={() => { account.setOpen(false); onOpenSettings(tab.id); }}
        ><tab.Icon size={15} aria-hidden="true"/><span>{tab.label}</span></button>)}
      </div>
      <div className="zpop-sep" aria-hidden="true"/>
      {onNewEntity && <button type="button" role="menuitem" className="zpop-item" onClick={() => { account.setOpen(false); onNewEntity(); }}><Plus size={15} aria-hidden="true"/><span>Nieuwe administratie</span></button>}
      <button type="button" role="menuitem" className="zpop-item" onClick={() => { account.setOpen(false); onNewOrganization(); }}><Plus size={15} aria-hidden="true"/><span>Nieuwe organisatie</span></button>
      <div className="zpop-sep" aria-hidden="true"/>
      <button type="button" role="menuitem" className="zpop-item danger" onClick={() => { account.setOpen(false); onSignOut(); }}><LogOut size={15} aria-hidden="true"/><span>Uitloggen</span></button>
    </div>}
  </aside>;
}
