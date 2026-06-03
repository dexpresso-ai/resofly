import { Children, Fragment, isValidElement, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ButtonHTMLAttributes, CSSProperties, InputHTMLAttributes, KeyboardEvent, ReactNode, TextareaHTMLAttributes } from 'react';

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  const { variant = 'ghost', className = '', ...rest } = props;
  return <button className={`btn btn-${variant} ${className}`} {...rest} />;
}
export function Input(props: InputHTMLAttributes<HTMLInputElement>) { return <input className="form-input" {...props} />; }

/** Curated project color palette. Built around the workspace accent tokens so
 *  every chosen colour stays on-brand and legible against the dark surfaces. */
export const PROJECT_COLORS: { value: string; label: string }[] = [
  { value: '#FFD966', label: 'Goud' },
  { value: '#34D399', label: 'Smaragd' },
  { value: '#60A5FA', label: 'Hemelsblauw' },
  { value: '#A78BFA', label: 'Lavendel' },
  { value: '#F472B6', label: 'Roze' },
  { value: '#F06B6B', label: 'Koraal' },
  { value: '#FF9F43', label: 'Mandarijn' },
  { value: '#2DD4BF', label: 'Turkoois' },
  { value: '#FACC15', label: 'Citroen' },
  { value: '#94A3B8', label: 'Leisteen' },
];

export const DEFAULT_PROJECT_COLOR = PROJECT_COLORS[0].value;

const HEX_RE = /^#([0-9a-fA-F]{6})$/;
export function normalizeColor(value: string | null | undefined, fallback = DEFAULT_PROJECT_COLOR): string {
  if (typeof value !== 'string') return fallback;
  const v = value.trim();
  return HEX_RE.test(v) ? v.toUpperCase() : fallback;
}

export function ColorPicker({ value, onChange, disabled = false }: { value: string; onChange: (color: string) => void; disabled?: boolean }) {
  const current = normalizeColor(value);
  const isCustom = !PROJECT_COLORS.some(c => c.value.toUpperCase() === current);
  return (
    <div className="color-picker" role="radiogroup" aria-label="Projectkleur">
      {PROJECT_COLORS.map(c => {
        const selected = c.value.toUpperCase() === current;
        return (
          <button
            type="button"
            key={c.value}
            className={`color-swatch${selected ? ' is-selected' : ''}`}
            style={{ '--swatch': c.value } as CSSProperties}
            onClick={() => !disabled && onChange(c.value)}
            disabled={disabled}
            role="radio"
            aria-checked={selected}
            aria-label={c.label}
            title={c.label}
          />
        );
      })}
      {isCustom && (
        <button
          type="button"
          className="color-swatch is-selected is-custom"
          style={{ '--swatch': current } as CSSProperties}
          disabled
          aria-checked
          title={`Aangepast: ${current}`}
        />
      )}
    </div>
  );
}
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea className="form-textarea" {...props} />; }

/* ── Custom dropdown ───────────────────────────────────────────────────
 * Drop-in vervanging voor een native <select>. Houdt dezelfde API
 * (value / onChange met e.target.value / disabled / <option>-children),
 * maar rendert een eigen, volledig on-brand donker menu dat op élk
 * platform identiek is. Het menu wordt naar document.body geportald
 * zodat het nooit door modal- of scroll-overflow wordt afgekapt. */
type SelectChangeEvent = { target: { value: string } };
interface SelectProps {
  value?: string | number;
  onChange?: (event: SelectChangeEvent) => void;
  disabled?: boolean;
  children?: ReactNode;
  className?: string;
  placeholder?: string;
  inline?: boolean;
  id?: string;
  'aria-label'?: string;
}
interface ParsedOption { value: string; label: ReactNode; disabled: boolean }

function parseOptions(children: ReactNode): ParsedOption[] {
  const out: ParsedOption[] = [];
  Children.forEach(children, child => {
    if (!isValidElement(child)) return;
    if (child.type === Fragment) {
      out.push(...parseOptions((child.props as { children?: ReactNode }).children));
      return;
    }
    if (child.type === 'option') {
      const p = child.props as { value?: string | number; children?: ReactNode; disabled?: boolean };
      const value = String(p.value ?? '');
      out.push({ value, label: p.children ?? value, disabled: Boolean(p.disabled) });
    }
  });
  return out;
}

export function Select({ value, onChange, disabled = false, children, className, placeholder = 'Selecteer…', inline = false, id, ...rest }: SelectProps) {
  const options = parseOptions(children);
  const currentValue = value == null ? '' : String(value);
  const selected = options.find(o => o.value === currentValue);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const baseId = useId();

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const openUp = spaceBelow < 260 && r.top > spaceBelow;
    setMenuStyle({
      position: 'fixed',
      left: Math.round(r.left),
      width: Math.round(r.width),
      ...(openUp ? { bottom: Math.round(window.innerHeight - r.top + 4) } : { top: Math.round(r.bottom + 4) }),
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const onPointer = (e: MouseEvent) => {
      if (triggerRef.current?.contains(e.target as Node)) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onScroll = () => setOpen(false);
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const idx = options.findIndex(o => o.value === currentValue);
    setActiveIndex(idx >= 0 ? idx : options.findIndex(o => !o.disabled));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('.select-option.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const choose = (opt: ParsedOption) => {
    if (opt.disabled) return;
    setOpen(false);
    triggerRef.current?.focus();
    if (opt.value !== currentValue) onChange?.({ target: { value: opt.value } });
  };

  const moveActive = (dir: 1 | -1) => setActiveIndex(prev => {
    let i = prev;
    for (let step = 0; step < options.length; step++) {
      i = (i + dir + options.length) % options.length;
      if (!options[i]?.disabled) return i;
    }
    return prev;
  });

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); triggerRef.current?.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const o = options[activeIndex]; if (o) choose(o); }
    else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <div className={`select-control${inline ? ' is-inline' : ''}`}>
      <button
        type="button"
        ref={triggerRef}
        id={id}
        className={`select-trigger ${className ?? 'form-select'}${open ? ' is-open' : ''}${selected ? '' : ' is-placeholder'}`}
        disabled={disabled}
        onClick={() => !disabled && setOpen(o => !o)}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={rest['aria-label']}
      >
        <span className="select-value">{selected ? selected.label : placeholder}</span>
        <span className="select-chevron" aria-hidden="true">
          <svg width="12" height="8" viewBox="0 0 12 8" fill="none"><path d="M1 1l5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
      </button>
      {open && createPortal(
        <div ref={menuRef} className="select-menu" style={menuStyle} role="listbox" aria-activedescendant={activeIndex >= 0 ? `${baseId}-opt-${activeIndex}` : undefined}>
          {options.length === 0 && <div className="select-option is-disabled">Geen opties</div>}
          {options.map((opt, i) => (
            <div
              key={`${opt.value}-${i}`}
              id={`${baseId}-opt-${i}`}
              role="option"
              aria-selected={opt.value === currentValue}
              className={`select-option${opt.value === currentValue ? ' is-selected' : ''}${i === activeIndex ? ' is-active' : ''}${opt.disabled ? ' is-disabled' : ''}`}
              onMouseEnter={() => !opt.disabled && setActiveIndex(i)}
              onMouseDown={e => { e.preventDefault(); choose(opt); }}
            >
              <span className="select-option-label">{opt.label}</span>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
