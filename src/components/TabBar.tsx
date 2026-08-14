import { useEffect, useRef } from 'react';
import { Archive, BarChart3, Images, BookOpen, Boxes, Calendar, CalendarClock, CalendarRange, Clock, FileSignature, FileText, Files, FolderOpen, GanttChart, Landmark, LayoutDashboard, Library, Megaphone, MessageSquare, Percent, Plus, Receipt, Scale, Settings, StickyNote, Ticket, TrendingUp, Truck, Users, X } from 'lucide-react';
import type { AppData } from '../types';
import { viewTitle } from '../lib/workspaceTabs';

/** Minimale vorm van een tabblad die de tabbalk nodig heeft om te renderen. Het
 *  volledige WorkspaceTab-type (met view-state + editor) leeft in main.tsx; door
 *  hier structureel te typen vermijden we een circulaire import. */
type TabLike = { id: string; page: string; projectId: string | null; clientId: string | null; galleryId?: string | null };

// Icoon per pagina — op de telefoon draagt het icoon een tabblad dat níét actief
// is helemaal alleen (zie globals.css ≤760px), op desktop staat het vóór het
// tekstlabel.
const PAGE_ICON: Record<string, typeof LayoutDashboard> = {
  // Drie pagina's deelden hier hetzelfde Calendar-icoon. Op de telefoon toont
  // een werktab alléén het icoon, dus die waren onderling niet te
  // onderscheiden. Nu elk een eigen vorm.
  dashboard: LayoutDashboard, weekplanner: CalendarRange, calendar: Calendar,
  'meeting-booking': CalendarClock, time: Clock, stats: BarChart3, content: Library, notes: StickyNote,
  documents: Files, clients: Users, client: Users, projects: FolderOpen, project: FolderOpen,
  'project-planning': GanttChart, tickets: Ticket, chat: MessageSquare, marketing: Megaphone, quotes: FileText,
  contracts: FileSignature, invoices: Receipt, suppliers: Truck, 'purchase-invoices': FileText, ledger: BookOpen,
  bank: Landmark, assets: Boxes, pnl: TrendingUp, 'vat-returns': Percent, 'corporate-tax': Landmark, dga: Users, shareholders: Users, 'fiscal-years': CalendarClock,
  'annual-accounts': Scale,
  archive: Archive, settings: Settings, gallery: Images,
};

/** Browser-achtige tabbalk boven de werkruimte. Klik = wisselen, ×/middenklik =
 *  sluiten, + = nieuw tabblad. */
export function TabBar({ tabs, activeTabId, data, onSelect, onClose, onNew }: {
  tabs: TabLike[];
  activeTabId: string;
  data: AppData;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLDivElement | null>(null);

  /**
   * Het actieve tabblad hoort in beeld te staan. Op de telefoon past er een
   * handvol tabs in de balk en groeit het actieve tabblad omdat het zijn naam
   * toont — zonder dit meeschuiven open je een tabblad dat je vervolgens niet
   * ziet. `nearest` scrolt alleen als het nodig is, dus de balk springt niet bij
   * elke wissel.
   */
  useEffect(() => {
    const node = activeRef.current;
    if (!node || !stripRef.current) return;
    node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [activeTabId, tabs.length]);

  return (
    <div className="tabbar" role="tablist" aria-label="Open tabbladen" ref={stripRef}>
      <div className="tabbar-strip">
        {tabs.map(tab => {
          const active = tab.id === activeTabId;
          const label = viewTitle(tab, data);
          const Icon = PAGE_ICON[tab.page] ?? FileText;
          return (
            <div
              key={tab.id}
              ref={active ? activeRef : undefined}
              role="tab"
              aria-selected={active}
              // Rovende tabindex: Tab springt naar de tabbalk als geheel, niet
              // langs elk open tabblad afzonderlijk.
              tabIndex={active ? 0 : -1}
              className={`tab${active ? ' active' : ''}`}
              title={label}
              onClick={() => onSelect(tab.id)}
              onKeyDown={event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onSelect(tab.id);
              }}
              // Middenklik sluit het tabblad (zoals in een browser).
              onAuxClick={event => { if (event.button === 1) { event.preventDefault(); onClose(tab.id); } }}
            >
              <span className="tab-ico" aria-hidden="true"><Icon size={15} /></span>
              <span className="tab-label">{label}</span>
              <button
                type="button"
                className="tab-close"
                aria-label={`Tabblad "${label}" sluiten`}
                onClick={event => { event.stopPropagation(); onClose(tab.id); }}
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>
      {/* Buiten de scrollende strip: bij tien open tabbladen moet "nieuw" niet
          mee naar rechts verdwijnen. */}
      <button type="button" className="tab-new" aria-label="Nieuw tabblad" title="Nieuw tabblad" onClick={onNew}>
        <Plus size={15} />
      </button>
    </div>
  );
}
