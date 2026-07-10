import { Plus, X } from 'lucide-react';
import type { AppData } from '../types';
import { viewTitle } from '../lib/workspaceTabs';

/** Minimale vorm van een tabblad die de tabbalk nodig heeft om te renderen. Het
 *  volledige WorkspaceTab-type (met view-state + editor) leeft in main.tsx; door
 *  hier structureel te typen vermijden we een circulaire import. */
type TabLike = { id: string; page: string; projectId: string | null; clientId: string | null };

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
  return (
    <div className="tabbar" role="tablist" aria-label="Open tabbladen">
      {tabs.map(tab => {
        const active = tab.id === activeTabId;
        const label = viewTitle(tab, data);
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            className={`tab${active ? ' active' : ''}`}
            title={label}
            onClick={() => onSelect(tab.id)}
            // Middenklik sluit het tabblad (zoals in een browser).
            onAuxClick={event => { if (event.button === 1) { event.preventDefault(); onClose(tab.id); } }}
          >
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
      <button type="button" className="tab-new" aria-label="Nieuw tabblad" title="Nieuw tabblad" onClick={onNew}>
        <Plus size={15} />
      </button>
    </div>
  );
}
