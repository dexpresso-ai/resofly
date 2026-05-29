import type { ButtonHTMLAttributes, CSSProperties, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

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
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) { return <select className="form-select" {...props} />; }
