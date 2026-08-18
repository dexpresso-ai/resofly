import { Children, Fragment, isValidElement, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import type { ButtonHTMLAttributes, CSSProperties, InputHTMLAttributes, KeyboardEvent, ReactNode, TextareaHTMLAttributes } from 'react';

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  const { variant = 'ghost', className = '', ...rest } = props;
  return <button className={`btn btn-${variant} ${className}`} {...rest} />;
}
export function Input(props: InputHTMLAttributes<HTMLInputElement>) { return <input className="form-input" {...props} />; }

/** Laadplaceholder in de huisstijl — vervangt kale "Laden…"-tekst door rustig
 *  glanzende regels die de vorm van de komende inhoud aankondigen. `role=status`
 *  + `aria-label` houden het aangekondigd voor schermlezers; de losse regels zijn
 *  puur decoratief. */
export function Skeleton({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  return (
    <div className={`skeleton ${className}`.trim()} role="status" aria-label="Laden…" aria-busy="true">
      {Array.from({ length: Math.max(1, lines) }, (_, i) => (
        <span key={i} className="skeleton-line" aria-hidden="true" />
      ))}
    </div>
  );
}

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
  /** Zoekveld boven de opties. Standaard `undefined` = automatisch aan zodra de
   *  lijst lang genoeg is om niet meer in één blik te scannen. */
  searchable?: boolean;
  searchPlaceholder?: string;
  'aria-label'?: string;
}
interface ParsedOption { value: string; label: ReactNode; disabled: boolean; text: string }

/** Vanaf hoeveel opties het zoekveld vanzelf verschijnt. Korter dan dit scan je
 *  met je ogen sneller dan met een zoekveld; langer (klanten, projecten,
 *  grootboekrekeningen, teamleden) wordt scrollen het werk. */
const SEARCHABLE_THRESHOLD = 10;

/** Platte tekst uit een optielabel, zodat er ook gezocht kan worden in labels
 *  die uit elementen bestaan (badge + naam) in plaats van kale tekst. */
function optionText(label: ReactNode, fallback: string): string {
  const parts: string[] = [];
  const walk = (node: ReactNode) => {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (typeof node === 'string' || typeof node === 'number') { parts.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (isValidElement(node)) walk((node.props as { children?: ReactNode }).children);
  };
  walk(label);
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

/** Kleine letters zonder accenten: "Bäcker" vindt "backer" en andersom. */
function normalizeSearch(value: string): string {
  return value.toLocaleLowerCase('nl-NL').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

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
      const label = p.children ?? value;
      out.push({ value, label, disabled: Boolean(p.disabled), text: optionText(label, value) });
    }
  });
  return out;
}

export function Select({ value, onChange, disabled = false, children, className, placeholder = 'Selecteer…', inline = false, id, searchable, searchPlaceholder = 'Zoeken…', ...rest }: SelectProps) {
  const options = parseOptions(children);
  const currentValue = value == null ? '' : String(value);
  const selected = options.find(o => o.value === currentValue);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const baseId = useId();

  const isSearchable = searchable ?? options.length >= SEARCHABLE_THRESHOLD;
  const needle = isSearchable ? normalizeSearch(query) : '';
  // `visible` is waar het toetsenbord en de muis op werken; `options` blijft de
  // volledige lijst (nodig om de huidige waarde te kunnen tonen).
  const visible = needle ? options.filter(o => normalizeSearch(o.text).includes(needle)) : options;

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 4;
    const margin = 8;
    // Een zoekveld eet zelf een strook op, dus mag het menu iets hoger worden —
    // anders blijven er maar een paar opties over om uit te kiezen.
    const cap = isSearchable ? 336 : 264;
    const spaceBelow = window.innerHeight - r.bottom - gap;
    const spaceAbove = r.top - gap;
    const openUp = spaceBelow < cap && spaceAbove > spaceBelow;
    // Beperk de hoogte tot de beschikbare ruimte in de gekozen richting zodat
    // het menu nooit buiten beeld valt (anders zijn onderste opties onbereikbaar).
    const available = (openUp ? spaceAbove : spaceBelow) - margin;
    setMenuStyle({
      position: 'fixed',
      left: Math.round(r.left),
      width: Math.round(r.width),
      maxHeight: Math.min(cap, Math.max(120, Math.round(available))),
      ...(openUp ? { bottom: Math.round(window.innerHeight - r.top + gap) } : { top: Math.round(r.bottom + gap) }),
    });
  }, [isSearchable]);

  /** Sluiten wist meteen de zoekterm. Bleef die staan, dan opende het menu de
   *  volgende keer een frame lang op je vórige zoekopdracht — en dus soms op
   *  een lege lijst. */
  const closeMenu = useCallback(() => { setOpen(false); setQuery(''); }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const onPointer = (e: MouseEvent) => {
      if (triggerRef.current?.contains(e.target as Node)) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      closeMenu();
    };
    const onScroll = (e: Event) => {
      // Scrollen binnen het menu zelf (lange optielijsten) mag het niet sluiten.
      if (menuRef.current?.contains(e.target as Node)) return;
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // Sluit alleen wanneer de trigger uit beeld scrolt; anders blijft het menu
      // aan de trigger 'plakken' in plaats van te verdwijnen bij elke scroll.
      if (r.bottom <= 0 || r.top >= window.innerHeight) closeMenu();
      else place();
    };
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, place, closeMenu]);

  useEffect(() => {
    if (!open) return;
    const idx = options.findIndex(o => o.value === currentValue);
    setActiveIndex(idx >= 0 ? idx : options.findIndex(o => !o.disabled));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Focus alleen op een muis-apparaat in het zoekveld. Op een telefoon zou het
  // toetsenbord meteen omhoogschieten en precies het menu bedekken waar je uit
  // moet kiezen; daar tik je het veld zelf aan wanneer je wilt zoeken.
  useEffect(() => {
    if (!open || !isSearchable) return;
    if (typeof window !== 'undefined' && window.matchMedia && !window.matchMedia('(pointer: fine)').matches) return;
    // Het menu staat al in de DOM wanneer dit effect draait, dus direct focussen.
    // Via requestAnimationFrame zou de focus wegblijven zolang het tabblad niet
    // schildert (achtergrondtab), en dan typ je in het niets.
    searchRef.current?.focus();
  }, [open, isSearchable]);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('.select-option.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const choose = (opt: ParsedOption) => {
    if (opt.disabled) return;
    closeMenu();
    triggerRef.current?.focus();
    if (opt.value !== currentValue) onChange?.({ target: { value: opt.value } });
  };

  const moveActive = (dir: 1 | -1) => setActiveIndex(prev => {
    let i = prev;
    for (let step = 0; step < visible.length; step++) {
      i = (i + dir + visible.length) % visible.length;
      if (!visible[i]?.disabled) return i;
    }
    return prev;
  });

  const onSearch = (next: string) => {
    setQuery(next);
    // Na elke aanslag springt de markering naar het eerste treffer-item, zodat
    // Enter altijd het bovenste resultaat kiest.
    const trimmed = normalizeSearch(next);
    const list = trimmed ? options.filter(o => normalizeSearch(o.text).includes(trimmed)) : options;
    setActiveIndex(list.findIndex(o => !o.disabled));
  };

  /** Toetsafhandeling die zowel vanaf de knop als vanuit het zoekveld werkt. */
  const handleOpenKeys = (e: KeyboardEvent<HTMLElement>, allowSpace: boolean) => {
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); triggerRef.current?.focus(); return true; }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); return true; }
    if (e.key === 'Enter' || (allowSpace && e.key === ' ')) { e.preventDefault(); const o = visible[activeIndex]; if (o) choose(o); return true; }
    if (e.key === 'Tab') { closeMenu(); return true; }
    return false;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); }
      return;
    }
    handleOpenKeys(e, true);
  };

  // In het zoekveld blijft de spatiebalk een spatie: die hoort in je zoekterm,
  // niet als "kies dit item".
  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => { handleOpenKeys(e, false); };

  return (
    <div className={`select-control${inline ? ' is-inline' : ''}`}>
      <button
        type="button"
        ref={triggerRef}
        id={id}
        className={`select-trigger ${className ?? 'form-select'}${open ? ' is-open' : ''}${selected ? '' : ' is-placeholder'}`}
        disabled={disabled}
        onClick={() => { if (disabled) return; if (open) closeMenu(); else setOpen(true); }}
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
        <div ref={menuRef} className={`select-menu${isSearchable ? ' has-search' : ''}`} style={menuStyle}>
          {isSearchable && (
            <div className="select-search">
              <Search size={14} aria-hidden="true" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={e => onSearch(e.target.value)}
                onKeyDown={onSearchKeyDown}
                placeholder={searchPlaceholder}
                autoComplete="off"
                spellCheck={false}
                role="combobox"
                aria-expanded="true"
                aria-controls={`${baseId}-list`}
                aria-activedescendant={activeIndex >= 0 ? `${baseId}-opt-${activeIndex}` : undefined}
                aria-label={searchPlaceholder}
              />
            </div>
          )}
          <div
            id={`${baseId}-list`}
            className="select-menu-list"
            role="listbox"
            aria-activedescendant={!isSearchable && activeIndex >= 0 ? `${baseId}-opt-${activeIndex}` : undefined}
          >
            {options.length === 0 && <div className="select-option is-disabled">Geen opties</div>}
            {options.length > 0 && visible.length === 0 && <div className="select-empty">Niets gevonden voor “{query.trim()}”</div>}
            {visible.map((opt, i) => (
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
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
