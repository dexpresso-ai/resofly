import { useEffect, useId, useRef, useState } from 'react';
import type React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useBackStep } from '../lib/useBackStep';
import { addDays, formatISODate, isoWeekNumber, isSameDay, startOfWeek } from '../lib/dates';
import { MONTHS_LONG, pickerWeeks } from '../lib/weekView';

/**
 * Een knop met een paneel eronder: de weekkiezer, de filters en de weergave in
 * de kop van de weekplanner. Klik ernaast, Esc of de terugknop van de telefoon
 * sluit hem — dezelfde drie wegen als bij elk ander menu in de app.
 */
export function PlannerPopover({ trigger, triggerClassName = '', triggerLabel, title, panelClassName = '', align = 'end', badge, children }: {
  trigger: React.ReactNode;
  triggerClassName?: string;
  /** Toegankelijke naam als de knop alleen een icoon is. */
  triggerLabel?: string;
  title?: string;
  panelClassName?: string;
  align?: 'start' | 'end';
  badge?: number;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();
  const close = () => setOpen(false);
  useBackStep(open, close);

  useEffect(() => {
    if (!open) return;
    // Een keuzelijst in het paneel (Select) zet zijn menu via een portal onder
    // <body>. Een klik daarin is dus "buiten" het paneel; zonder deze uitzondering
    // sloot het filterpaneel al bij het indrukken en ging de keuze verloren.
    const insideOwnMenu = (target: EventTarget | null) => target instanceof Element && !!target.closest('.select-menu');
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && rootRef.current.contains(event.target)) return;
      if (insideOwnMenu(event.target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Esc sluit eerst een open keuzelijst, pas daarna het paneel.
      if (document.querySelector('.select-menu')) return;
      setOpen(false);
      rootRef.current?.querySelector<HTMLButtonElement>('.wpp-trigger')?.focus();
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return <div className={`wpp${open ? ' is-open' : ''}`} ref={rootRef}>
    <button
      type="button"
      className={`wpp-trigger ${triggerClassName}`.trim()}
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      aria-label={triggerLabel}
      title={title}
      onClick={() => setOpen(value => !value)}
    >
      {trigger}
      {!!badge && <span className="wpp-badge" aria-hidden="true">{badge}</span>}
    </button>
    {open && <div id={panelId} className={`wpp-panel is-${align} ${panelClassName}`.trim()} role="dialog" aria-label={triggerLabel ?? title}>
      {children(close)}
    </div>}
  </div>;
}

/**
 * De weekkiezer: een maand met weeknummers, waarin je een hele week aanklikt.
 * Bladeren met pijltjes ging per week; wie in januari de week van de
 * jaarafsluiting wilde plannen, klikte tien keer.
 */
export function WeekPicker({ anchor, today, onPick }: {
  anchor: Date;
  today: Date;
  onPick: (monday: Date) => void;
}) {
  // De maand waarin het grootste deel van de gekozen week valt (de donderdag,
  // zoals bij ISO-weeknummers).
  const thursday = addDays(anchor, 3);
  const [month, setMonth] = useState(() => ({ year: thursday.getFullYear(), month: thursday.getMonth() }));
  const weeks = pickerWeeks(month.year, month.month);
  const anchorKey = formatISODate(startOfWeek(anchor));
  const todayWeekKey = formatISODate(startOfWeek(today));

  const shiftMonth = (step: number) => setMonth(prev => {
    const next = new Date(prev.year, prev.month + step, 1);
    return { year: next.getFullYear(), month: next.getMonth() };
  });

  return <div className="wpk">
    <div className="wpk-head">
      <button type="button" className="wpk-step" onClick={() => shiftMonth(-1)} aria-label="Vorige maand"><ChevronLeft size={15}/></button>
      <span className="wpk-month">{MONTHS_LONG[month.month]} {month.year}</span>
      <button type="button" className="wpk-step" onClick={() => shiftMonth(1)} aria-label="Volgende maand"><ChevronRight size={15}/></button>
    </div>
    <div className="wpk-grid" role="grid" aria-label={`Weken in ${MONTHS_LONG[month.month]} ${month.year}`}>
      <div className="wpk-row wpk-dow" role="row" aria-hidden="true">
        <span>wk</span>{['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'].map(day => <span key={day}>{day}</span>)}
      </div>
      {weeks.map(monday => {
        const key = formatISODate(monday);
        const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
        const last = days[6];
        return <button
          type="button"
          role="row"
          key={key}
          className={`wpk-row wpk-week${key === anchorKey ? ' is-on' : ''}${key === todayWeekKey ? ' is-now' : ''}`}
          aria-current={key === anchorKey ? 'true' : undefined}
          aria-label={`Week ${isoWeekNumber(monday)}, ${monday.getDate()} ${MONTHS_LONG[monday.getMonth()]} tot en met ${last.getDate()} ${MONTHS_LONG[last.getMonth()]}`}
          onClick={() => onPick(monday)}
        >
          <span className="wpk-wn">{isoWeekNumber(monday)}</span>
          {days.map(day => <span
            key={formatISODate(day)}
            className={`wpk-day${day.getMonth() !== month.month ? ' is-out' : ''}${isSameDay(day, today) ? ' is-today' : ''}`}
          >{day.getDate()}</span>)}
        </button>;
      })}
    </div>
    <div className="wpk-quick">
      <button type="button" onClick={() => onPick(startOfWeek(today))}>Deze week</button>
      <button type="button" onClick={() => onPick(addDays(startOfWeek(today), 7))}>Volgende week</button>
    </div>
  </div>;
}

/** Een rij keuzeknoppen met één actieve stand. */
export function Segmented<T extends string>({ value, options, onChange, label, className = '' }: {
  value: T;
  options: { value: T; label: React.ReactNode; title?: string; hidden?: boolean }[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  return <div className={`wp-seg ${className}`.trim()} role="group" aria-label={label}>
    {options.filter(option => !option.hidden).map(option => <button
      key={option.value}
      type="button"
      className={value === option.value ? 'is-on' : ''}
      aria-pressed={value === option.value}
      title={option.title}
      onClick={() => onChange(option.value)}
    >{option.label}</button>)}
  </div>;
}
