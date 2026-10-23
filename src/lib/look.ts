import { useCallback, useSyncExternalStore } from 'react';
import { reapplyTheme } from './theme';

/**
 * De look van de werkruimte. 'cockpit' is wat er nu staat (Belicht met de
 * Cockpit-laag); 'zenit' is de nieuwe voorkant uit het designvoorstel van
 * 2026-10-22 (DESIGN_VOORSTEL_ZENIT_2026-10-22.md).
 *
 * Zenit staat achter de schakelaar *Probeer Zenit* in het accountmenu, per
 * gebruiker en per browser. Wie hem niet aanzet, ziet niets veranderen: alle
 * regels van src/styles/zenit.css hangen aan `data-look="zenit"` op <html>.
 */
export type Look = 'cockpit' | 'zenit';

/** Zelfde sleutel als het bootstrap-script in index.html, dat `data-look` al
 *  vóór de eerste verf zet. Die twee MOETEN gelijk blijven. */
export const LOOK_STORAGE_KEY = 'resofly.look';

export function loadLook(): Look {
  try {
    return localStorage.getItem(LOOK_STORAGE_KEY) === 'zenit' ? 'zenit' : 'cockpit';
  } catch {
    return 'cockpit';
  }
}

export function applyLook(look: Look): void {
  const root = document.documentElement;
  if (look === 'zenit') root.setAttribute('data-look', 'zenit');
  else root.removeAttribute('data-look');
  // De grondkleur van Zenit verschilt een tikje; de adresbalk gaat mee.
  reapplyTheme();
}

let current: Look = typeof window === 'undefined' ? 'cockpit' : loadLook();
const listeners = new Set<() => void>();

export function setLook(next: Look): void {
  current = next;
  try {
    if (next === 'zenit') localStorage.setItem(LOOK_STORAGE_KEY, 'zenit');
    else localStorage.removeItem(LOOK_STORAGE_KEY);
  } catch { /* privémodus: dan geldt de keuze alleen voor dit venster */ }
  applyLook(next);
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useLook(): [Look, (next: Look) => void] {
  const look = useSyncExternalStore(subscribe, () => current, () => 'cockpit' as Look);
  const set = useCallback((next: Look) => setLook(next), []);
  return [look, set];
}
