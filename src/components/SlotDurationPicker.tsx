import { useCallback, useState } from 'react';

/**
 * Hoe een getekend blok in momenten wordt opgedeeld: de duur van één moment en
 * de pauze ertussen (splitIntoSlots in src/lib/bookingLinks.ts).
 *
 * Waarom: eerst was elk getekend blok één moment. Wie een ochtend in halve uren
 * wilde aanbieden, sleepte zes keer precies op de rasterlijnen, en een sleep
 * van 9.00 tot 12.00 uur gaf de klant één afspraak van drie uur. Nu sleep je
 * de ochtend in één keer, en een klik zonder slepen is één moment.
 *
 * De keuze blijft op dit apparaat bewaard: wie altijd gesprekken van een uur
 * aanbiedt, hoeft dat niet elke keer opnieuw te kiezen.
 */
export type SlotSplit = { durationMin: number; bufferMin: number };

const STORAGE_KEY = 'resofly.booking.slotSplit';
const DEFAULT: SlotSplit = { durationMin: 30, bufferMin: 0 };
const DURATIONS = [15, 30, 45, 60, 90];
const BUFFERS = [0, 5, 10, 15, 30];

function readStored(): SlotSplit {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<SlotSplit> | null;
    const durationMin = Number(raw?.durationMin);
    const bufferMin = Number(raw?.bufferMin);
    return {
      durationMin: durationMin === 0 || DURATIONS.includes(durationMin) ? durationMin : DEFAULT.durationMin,
      bufferMin: BUFFERS.includes(bufferMin) ? bufferMin : DEFAULT.bufferMin,
    };
  } catch {
    return DEFAULT;
  }
}

export function useSlotSplit(): [SlotSplit, (next: SlotSplit) => void] {
  const [split, setSplit] = useState<SlotSplit>(() => (typeof window === 'undefined' ? DEFAULT : readStored()));
  const update = useCallback((next: SlotSplit) => {
    setSplit(next);
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* privémodus: dan onthouden we het niet */ }
  }, []);
  return [split, update];
}

/** "30 min", "1 uur", "1,5 uur". */
export function minutesLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  return minutes % 60 === 0 ? `${minutes / 60} uur` : `${String(minutes / 60).replace('.', ',')} uur`;
}

export function SlotDurationPicker({ value, onChange, disabled = false, allowAsDrawn = true }: {
  value: SlotSplit;
  onChange: (next: SlotSplit) => void;
  disabled?: boolean;
  /** "Zoals getekend" alleen waar je tekent; een weekpatroon heeft altijd een duur. */
  allowAsDrawn?: boolean;
}) {
  return (
    <div className="slot-split">
      <span className="slot-split-label">Momenten van</span>
      <div className="slot-seg" role="radiogroup" aria-label="Duur van één moment">
        {DURATIONS.map(min => (
          <button key={min} type="button" role="radio" aria-checked={value.durationMin === min} disabled={disabled}
            onClick={() => onChange({ ...value, durationMin: min })}>{minutesLabel(min)}</button>
        ))}
        {allowAsDrawn && <button type="button" role="radio" aria-checked={value.durationMin === 0} disabled={disabled}
          title="Elk getekend blok is één moment, hoe lang ook"
          onClick={() => onChange({ ...value, durationMin: 0 })}>Zoals getekend</button>}
      </div>
      {value.durationMin > 0 && (
        <label className="slot-split-buffer">
          <span>Pauze ertussen</span>
          <select className="form-input" value={value.bufferMin} disabled={disabled} onChange={e => onChange({ ...value, bufferMin: Number(e.target.value) })}>
            {BUFFERS.map(b => <option key={b} value={b}>{b === 0 ? 'Geen' : `${b} min`}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}
