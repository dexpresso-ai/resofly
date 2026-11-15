import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, ChevronDown, type LucideIcon } from 'lucide-react';
import { useBackStep } from '../lib/useBackStep';

export type GalleryMenuItem = {
  key: string;
  label: string;
  /** Eén regel uitleg onder het label: wát er gebeurt, in gewone woorden. */
  hint?: string;
  Icon: LucideIcon;
  onSelect: () => void;
  /**
   * Een stand die aan of uit staat (slepen, indelen). Dan krijgt de regel een
   * vinkje en zegt hij dat ook tegen een schermlezer. `undefined` = gewone handeling.
   */
  checked?: boolean;
  /** Een teller rechts, zoals het aantal foto's dat nog niet is ingedeeld. */
  badge?: number;
  disabled?: boolean;
  /** Iets wat je niet terugdraait, zoals verwijderen: rood. */
  danger?: boolean;
};

/** `false`/`null` in `items` vallen weg: zo kan een regel er voorwaardelijk in. */
export type GalleryMenuSection = { title?: string; items: Array<GalleryMenuItem | false | null | undefined> };

/**
 * Een knop met een uitklapmenu voor de galerij-werkbalk.
 *
 * De werkbalk had tot 15 november elf losse knoppen, een keuzelijst en twee
 * pillen op één rij. Op een laptop liep die over twee regels en drukte hij de
 * naam van de galerij weg tot "Ankie …"; op de telefoon werd het een strook
 * om zijwaarts door te vegen. Wat je niet elke minuut nodig hebt, staat nu
 * hierin, met per regel een zin uitleg in plaats van alleen een woord.
 *
 * Het gedrag volgt het menu "+ Nieuw" (CreateMenu): pijltjes, Escape, Tab en
 * een klik ernaast sluiten het, en de terugknop van de telefoon ook.
 */
export function GalleryMenu({
  label, Icon, sections, footer, iconOnly = false, active = false, badge, badgeLabel, className = '',
}: {
  label: string;
  Icon: LucideIcon;
  /** Een lege groep (of `false`) valt weg; zonder één regel staat de knop er niet. */
  sections: Array<GalleryMenuSection | false | null | undefined>;
  /** Iets onder de regels dat geen handeling is, zoals de opslagmeter. */
  footer?: ReactNode;
  /** Alleen het icoon in de knop; het label blijft de naam voor schermlezers. */
  iconOnly?: boolean;
  /** Er staat een stand uit dit menu aan (slepen, indelen): de knop laat dat zien. */
  active?: boolean;
  badge?: number;
  /** Wat de teller op de knop betekent, voor de tooltip en schermlezers. */
  badgeLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useBackStep(open, () => setOpen(false));

  const visible = sections
    .filter((s): s is GalleryMenuSection => Boolean(s))
    .map(s => ({ title: s.title, items: s.items.filter((item): item is GalleryMenuItem => Boolean(item)) }))
    .filter(s => s.items.length > 0);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    // Het menu opent met de focus op de eerste regel, zodat je met de pijltjes
    // verder kunt (menu-button-patroon). Na een klik met de muis toont de
    // browser daar geen focusrand bij (:focus-visible).
    boxRef.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus();
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  if (visible.length === 0) return null;

  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      // Anders sluit dezelfde toets ook de presenteerstand eromheen.
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      close(true);
      return;
    }
    if (event.key === 'Tab') { setOpen(false); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(boxRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? []);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (index + 1) % items.length
      : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  const showBadge = badge != null && badge > 0;
  const triggerTitle = showBadge && badgeLabel ? `${label} — ${badgeLabel}` : label;

  return (
    <div className={`gal-menu-box${className ? ` ${className}` : ''}`} ref={boxRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`btn btn-ghost gal-menu-trigger${iconOnly ? ' is-icon' : ''}${active ? ' is-on' : ''}${open ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={iconOnly ? triggerTitle : undefined}
        title={iconOnly ? triggerTitle : (showBadge && badgeLabel ? badgeLabel : undefined)}
        onClick={() => setOpen(value => !value)}
        onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); } }}
      >
        <Icon size={15} aria-hidden="true" />
        {!iconOnly && <span className="gal-menu-trigger-label">{label}</span>}
        {showBadge && <span className="gal-menu-count" aria-hidden={iconOnly ? 'true' : undefined}>{badge}</span>}
        {!iconOnly && <ChevronDown size={14} className="gal-menu-caret" aria-hidden="true" />}
      </button>
      {open && (
        <div id={menuId} className="gal-menu" role="menu" aria-label={label} onKeyDown={onMenuKeyDown}>
          {visible.map((section, sectionIndex) => (
            <div key={section.title ?? sectionIndex} className="gal-menu-section" role="group" aria-label={section.title}>
              {section.title && <div className="gal-menu-head" aria-hidden="true">{section.title}</div>}
              {section.items.map(item => {
                const ItemIcon = item.Icon;
                const isToggle = item.checked !== undefined;
                return (
                  <button
                    key={item.key}
                    type="button"
                    role={isToggle ? 'menuitemcheckbox' : 'menuitem'}
                    aria-checked={isToggle ? item.checked : undefined}
                    className={`gal-menu-item${item.checked ? ' is-checked' : ''}${item.danger ? ' is-danger' : ''}`}
                    disabled={item.disabled}
                    onClick={() => { close(false); item.onSelect(); }}
                  >
                    <span className="gal-menu-ico" aria-hidden="true"><ItemIcon size={16} /></span>
                    <span className="gal-menu-text">
                      <b>{item.label}</b>
                      {item.hint && <small>{item.hint}</small>}
                    </span>
                    {item.badge != null && item.badge > 0 && <span className="gal-menu-count">{item.badge}</span>}
                    {item.checked && <Check size={16} className="gal-menu-check" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          ))}
          {footer && <div className="gal-menu-foot">{footer}</div>}
        </div>
      )}
    </div>
  );
}
