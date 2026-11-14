import { createContext, useContext, useEffect, useRef } from 'react';
import { backButton, type BackHandler } from './backButton';

/**
 * Staat dit deel van het scherm in beeld? Alle werktabbladen blijven
 * gemount (keep-alive); een venster in een tabblad dat je niet ziet, hoort
 * niet dicht te gaan als je op terug drukt. main.tsx zet dit per tabblad.
 */
export const BackScope = createContext(true);

/**
 * Meldt een venster, menu of scherm aan bij de terugknop van de telefoon:
 * terug doet dan `onBack`, hetzelfde als de knop om te sluiten in beeld.
 *
 * `steps` is `true` zolang het open is, of een aantal als terug meer stappen
 * achter elkaar kan doen (een map diep in mappen: elke druk één map omhoog).
 * Wat het laatst openging, sluit als eerste. Zie backButton.ts.
 */
export function useBackStep(steps: number | boolean, onBack: BackHandler): void {
  const inView = useContext(BackScope);
  const count = typeof steps === 'number' ? Math.max(0, Math.floor(steps)) : steps ? 1 : 0;
  const active = inView ? count : 0;
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  // Het volgnummer blijft zolang het open is, ook als je even een ander
  // tabblad bekijkt: terug in dat tabblad sluit het dan nog in de goede volgorde.
  const seqRef = useRef<number | null>(null);
  const open = count > 0;

  useEffect(() => {
    if (!open) seqRef.current = null;
  }, [open]);

  useEffect(() => {
    if (active === 0) return;
    const button = backButton();
    if (seqRef.current === null) seqRef.current = button.nextSeq();
    return button.addLayer(seqRef.current, active, (n) => onBackRef.current(n));
  }, [active]);
}
