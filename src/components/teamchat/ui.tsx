import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type ReactNode, type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Hash, Lock, Users, X } from 'lucide-react';
import type { OrganizationMember } from '../../types';
import { avatarHue, memberDisplay, PRESENCE_LABEL, type Presence } from './model';

/**
 * Bouwstenen van de teamchat: avatars met de statusbadges van Teams, menu's en
 * popovers (via een portal, zodat een scrollgebied ze niet afknipt) en het
 * dialoogvenster.
 */

/** Onder deze grens is er maar plaats voor één venster tegelijk (zie globals.css). */
export const NARROW_QUERY = '(max-width:760px)';

export function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

/** Touchscreen zonder muis: daar bestaat "hover" niet en werkt alleen een tik. */
export function isTouchOnly(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(hover:none)').matches;
}

// ── Statusbadge (de rondjes van Teams) ────────────────────────────────────────

export function PresenceBadge({ presence, size = 12, ring = true }: { presence: Presence; size?: number; ring?: boolean }) {
  return (
    <span className={`tmc-presence is-${presence}${ring ? ' has-ring' : ''}`} style={{ width: size, height: size }} title={PRESENCE_LABEL[presence]} aria-label={PRESENCE_LABEL[presence]} role="img">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        {presence === 'available' && <><circle cx="8" cy="8" r="8" className="tmc-presence-fill" /><path d="M4.6 8.3l2.2 2.2 4.6-4.8" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></>}
        {presence === 'busy' && <circle cx="8" cy="8" r="8" className="tmc-presence-fill" />}
        {presence === 'dnd' && <><circle cx="8" cy="8" r="8" className="tmc-presence-fill" /><rect x="4" y="7" width="8" height="2" rx="1" fill="#fff" /></>}
        {(presence === 'away' || presence === 'brb') && <><circle cx="8" cy="8" r="8" className="tmc-presence-fill" /><path d="M8 4.4v4.1l2.6 1.6" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></>}
        {presence === 'offline' && <><circle cx="8" cy="8" r="6.6" fill="none" className="tmc-presence-stroke" strokeWidth="2.2" /><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" className="tmc-presence-stroke" strokeWidth="1.7" strokeLinecap="round" /></>}
      </svg>
    </span>
  );
}

// ── Avatars ──────────────────────────────────────────────────────────────────

export function Avatar({ userId, member, size = 32, presence, title }: {
  userId: string | null | undefined;
  member?: OrganizationMember;
  size?: number;
  presence?: Presence;
  title?: string;
}) {
  const display = memberDisplay(member);
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.38)), '--av-h': avatarHue(userId) } as CSSProperties;
  return (
    <span className="tmc-avatar" style={style} title={title} aria-hidden={title ? undefined : true}>
      {display.initials}
      {presence && <PresenceBadge presence={presence} size={Math.max(10, Math.round(size * 0.36))} />}
    </span>
  );
}

/** Groepschat: twee gezichten schuin over elkaar, zoals Teams dat doet. */
export function GroupAvatar({ ids, memberById, size = 32 }: { ids: string[]; memberById: Map<string, OrganizationMember>; size?: number }) {
  if (ids.length < 2) {
    return (
      <span className="tmc-avatar tmc-avatar-group" style={{ width: size, height: size } as CSSProperties} aria-hidden="true">
        <Users size={Math.round(size * 0.5)} />
      </span>
    );
  }
  const small = Math.round(size * 0.64);
  return (
    <span className="tmc-avatar-pair" style={{ width: size, height: size }} aria-hidden="true">
      <Avatar userId={ids[0]} member={memberById.get(ids[0])} size={small} />
      <Avatar userId={ids[1]} member={memberById.get(ids[1])} size={small} />
    </span>
  );
}

export function ChannelAvatar({ title, size = 32, isPrivate }: { title: string; size?: number; isPrivate?: boolean }) {
  const style = { width: size, height: size, '--av-h': avatarHue(title) } as CSSProperties;
  return (
    <span className="tmc-avatar tmc-avatar-channel" style={style} aria-hidden="true">
      <Hash size={Math.round(size * 0.48)} />
      {isPrivate && <span className="tmc-avatar-lock"><Lock size={9} /></span>}
    </span>
  );
}

/** Het team (de organisatie) in de lijst Teams: een vierkantje met initialen. */
export function TeamAvatar({ name, size = 30 }: { name: string; size?: number }) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const initials = (words.length >= 2 ? `${words[0][0]}${words[1][0]}` : name.slice(0, 2)).toUpperCase();
  const style = { width: size, height: size, fontSize: Math.round(size * 0.4), '--av-h': avatarHue(name) } as CSSProperties;
  return <span className="tmc-avatar tmc-avatar-team" style={style} aria-hidden="true">{initials}</span>;
}

// ── Popover en menu (via een portal) ─────────────────────────────────────────

type Placement = 'below-start' | 'below-end' | 'above-start' | 'above-end' | 'right-start';

/**
 * Een zwevend paneel naast een knop. Het staat in een portal met vaste
 * positie: een scrollende berichtenlijst of een smal paneel knipt het dan niet
 * af. Past het niet onder de knop, dan klapt het naar boven (en andersom).
 */
export function Popover({ anchorRef, open, onClose, placement = 'below-end', children, className = '', width, label }: {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  placement?: Placement;
  children: ReactNode;
  className?: string;
  width?: number;
  label?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const a = anchor.getBoundingClientRect();
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 6;
    let top: number;
    let left: number;
    if (placement === 'right-start') {
      left = a.right + gap;
      top = a.top;
      if (left + w > vw - 8) left = Math.max(8, a.left - w - gap);
    } else {
      const wantAbove = placement.startsWith('above');
      const spaceBelow = vh - a.bottom - gap - 8;
      const spaceAbove = a.top - gap - 8;
      const above = wantAbove ? (spaceAbove >= Math.min(h, 220) || spaceAbove > spaceBelow) : (spaceBelow < Math.min(h, 220) && spaceAbove > spaceBelow);
      top = above ? a.top - gap - h : a.bottom + gap;
      left = placement.endsWith('end') ? a.right - w : a.left;
    }
    left = Math.min(Math.max(8, left), Math.max(8, vw - w - 8));
    top = Math.min(Math.max(8, top), Math.max(8, vh - h - 8));
    setPos({ top, left, maxHeight: vh - 16 });
  }, [anchorRef, placement]);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    place();
    const raf = window.requestAnimationFrame(place);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (ev: Event) => {
      const target = ev.target as Node;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); onClose(); anchorRef.current?.focus?.(); } };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose, anchorRef]);

  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={panelRef}
      className={`tmc tmc-popover ${className}`}
      role="dialog"
      aria-label={label}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width, maxHeight: pos?.maxHeight, visibility: pos ? 'visible' : 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  );
}

export interface MenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Een scheidingslijn erboven. */
  divider?: boolean;
  hint?: string;
  checked?: boolean;
}

/** Een menu van Teams: pijltjes, Enter, Escape. */
export function Menu({ anchorRef, open, onClose, items, placement = 'below-end', label = 'Meer opties' }: {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  items: MenuItem[];
  placement?: Placement;
  label?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const t = window.requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus());
    return () => window.cancelAnimationFrame(t);
  }, [open]);

  function onKeyDown(e: React.KeyboardEvent) {
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(idx + 1) % buttons.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(idx - 1 + buttons.length) % buttons.length]?.focus(); }
    if (e.key === 'Home') { e.preventDefault(); buttons[0]?.focus(); }
    if (e.key === 'End') { e.preventDefault(); buttons[buttons.length - 1]?.focus(); }
  }

  return (
    <Popover anchorRef={anchorRef} open={open} onClose={onClose} placement={placement} className="tmc-menu" label={label}>
      <div ref={listRef} role="menu" aria-label={label} onKeyDown={onKeyDown}>
        {items.map((item) => (
          <div key={item.key}>
            {item.divider && <div className="tmc-menu-sep" role="separator" />}
            <button
              type="button"
              role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={item.checked}
              className={`tmc-menu-item${item.danger ? ' is-danger' : ''}${item.checked ? ' is-checked' : ''}`}
              disabled={item.disabled}
              onClick={() => { onClose(); item.onSelect(); }}
            >
              <span className="tmc-menu-icon">{item.icon}</span>
              <span className="tmc-menu-label">{item.label}</span>
              {item.hint && <span className="tmc-menu-hint">{item.hint}</span>}
            </button>
          </div>
        ))}
      </div>
    </Popover>
  );
}

// ── Dialoogvenster ───────────────────────────────────────────────────────────

export function Modal({ title, onClose, children, footer, width = 480, labelledBy }: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  labelledBy?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey);
    const t = window.requestAnimationFrame(() => {
      const first = panelRef.current?.querySelector<HTMLElement>('[autofocus], input, textarea, button:not(.tmc-modal-close)');
      first?.focus();
    });
    return () => { window.removeEventListener('keydown', onKey); window.cancelAnimationFrame(t); };
  }, [onClose]);
  return createPortal(
    <div className="tmc chat-modal-bg" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panelRef} className="tmc-modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy} style={{ width }}>
        <div className="tmc-modal-head">
          <h3 id={labelledBy}>{title}</h3>
          <button type="button" className="tmc-icon-btn tmc-modal-close" onClick={onClose} aria-label="Sluiten"><X size={18} /></button>
        </div>
        <div className="tmc-modal-body">{children}</div>
        {footer && <div className="tmc-modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Een knop met alleen een icoon (en een tooltip), optioneel met een teller. */
export function IconButton({ label, onClick, children, badge, active, className = '', buttonRef, disabled, expanded }: {
  label: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  badge?: number;
  active?: boolean;
  className?: string;
  buttonRef?: RefObject<HTMLButtonElement | null>;
  disabled?: boolean;
  expanded?: boolean;
}) {
  return (
    <button
      ref={buttonRef as RefObject<HTMLButtonElement>}
      type="button"
      className={`tmc-icon-btn${active ? ' is-active' : ''} ${className}`}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-expanded={expanded}
      disabled={disabled}
    >
      {children}
      {!!badge && badge > 0 && <span className="tmc-badge">{badge > 99 ? '99+' : badge}</span>}
    </button>
  );
}

/** Kopieert tekst naar het klembord, met een terugval voor oudere browsers. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}
