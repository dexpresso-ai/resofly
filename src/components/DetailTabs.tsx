import { useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface DetailTab<T extends string> {
  id: T;
  label: string;
  /** Teller achter de naam; 0 of leeg = geen teller. */
  count?: number;
  icon?: LucideIcon;
  /** Teller in accentkleur, voor ongelezen berichten. */
  unread?: boolean;
}

type Fade = 'none' | 'left' | 'right' | 'both';

/**
 * Tabstrook van een detailpagina (klantdossier, project). Eén pil-strook die op
 * een smal scherm opzij schuift in plaats van te stapelen; het actieve tabblad
 * schuift vanzelf in beeld en de strook vervaagt aan de kant waar nog meer
 * tabbladen staan. Bewust géén pijltjesnavigatie: de agenda luistert op window
 * naar ArrowLeft/Right en zou meeschakelen (zelfde keuze als in TabBar).
 */
export function DetailTabs<T extends string>({ tabs, active, onSelect, label, className }: {
  tabs: DetailTab<T>[];
  active: T;
  onSelect: (id: T) => void;
  /** Toegankelijke naam van de strook, bv. "Projectonderdelen". */
  label: string;
  className?: string;
}) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const [fade, setFade] = useState<Fade>('none');

  // Aan welke kant valt er nog iets te schuiven? Dat bepaalt de vervaging.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const update = () => {
      const overflow = bar.scrollWidth - bar.clientWidth;
      if (overflow <= 1) { setFade('none'); return; }
      const left = bar.scrollLeft > 1;
      const right = bar.scrollLeft < overflow - 1;
      setFade(left && right ? 'both' : left ? 'left' : right ? 'right' : 'none');
    };
    update();
    bar.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    observer?.observe(bar);
    return () => { bar.removeEventListener('scroll', update); observer?.disconnect(); };
  }, [tabs.length]);

  // Het actieve tabblad in beeld schuiven — alleen de strook zelf, niet de
  // pagina (scrollIntoView zou ook de inhoud verticaal kunnen verschuiven).
  useEffect(() => {
    const bar = barRef.current;
    const node = bar?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!bar || !node || bar.scrollWidth <= bar.clientWidth) return;
    const pad = 16;
    const start = node.offsetLeft - pad;
    const end = node.offsetLeft + node.offsetWidth + pad;
    if (start < bar.scrollLeft) bar.scrollTo({ left: Math.max(0, start), behavior: 'smooth' });
    else if (end > bar.scrollLeft + bar.clientWidth) bar.scrollTo({ left: end - bar.clientWidth, behavior: 'smooth' });
  }, [active]);

  return (
    <div ref={barRef} className={`client-tabs-bar${className ? ` ${className}` : ''}`} role="tablist" aria-label={label} data-fade={fade}>
      {tabs.map(tab => {
        const isActive = tab.id === active;
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`client-tab-btn${isActive ? ' active' : ''}`}
            onClick={() => onSelect(tab.id)}
          >
            {Icon && <span className="client-tab-ico" aria-hidden="true"><Icon size={14} /></span>}
            <span className="client-tab-label">{tab.label}</span>
            {tab.count != null && tab.count > 0 && <span className={`client-tab-badge${tab.unread ? ' unread' : ''}`}>{tab.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
