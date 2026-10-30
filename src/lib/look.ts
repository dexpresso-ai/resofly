import { useCallback, useSyncExternalStore } from 'react';
import { reapplyTheme } from './theme';

/**
 * De look van de werkruimte. 'cockpit' is wat er nu staat (Belicht met de
 * Cockpit-laag); 'zenit' is de voorkant uit het designvoorstel van 2026-10-22
 * (DESIGN_VOORSTEL_ZENIT_2026-10-22.md); 'stroom' die van 2026-10-30
 * (DESIGN_VOORSTEL_STROOM_2026-10-30.md).
 *
 * Zenit en Stroom staan achter een schakelaar in het accountmenu (*Probeer
 * Zenit*, *Probeer Stroom*), per gebruiker en per browser. Wie niets aanzet,
 * ziet niets veranderen: alle regels van src/styles/zenit.css hangen aan
 * `data-look="zenit"` op <html>, die van src/styles/stroom.css aan `data-stroom`.
 *
 * Stroom bouwt op Zenit: dezelfde rail, hetzelfde contextpaneel, dezelfde
 * rustige onderdelen. Daarom staat bij Stroom `data-look="zenit"` óók op
 * <html>, met `data-stroom` erbij. Elke regel die Zenit krijgt, geldt dan
 * vanzelf voor Stroom; stroom.css legt er het licht en het glas overheen.
 */
export type Look = 'cockpit' | 'zenit' | 'stroom';

/** Zelfde sleutel als het bootstrap-script in index.html, dat `data-look` al
 *  vóór de eerste verf zet. Die twee MOETEN gelijk blijven. */
export const LOOK_STORAGE_KEY = 'resofly.look';

/** Zenit of Stroom: de rail met het contextpaneel, geen titelbalk, de rustige
 *  onderdelen. Alleen Cockpit valt erbuiten. */
export function isZenitFamily(look: Look): boolean {
  return look === 'zenit' || look === 'stroom';
}

export function loadLook(): Look {
  try {
    const stored = localStorage.getItem(LOOK_STORAGE_KEY);
    return stored === 'zenit' || stored === 'stroom' ? stored : 'cockpit';
  } catch {
    return 'cockpit';
  }
}

export function applyLook(look: Look): void {
  const root = document.documentElement;
  if (isZenitFamily(look)) root.setAttribute('data-look', 'zenit');
  else root.removeAttribute('data-look');
  if (look === 'stroom') root.setAttribute('data-stroom', '');
  else root.removeAttribute('data-stroom');
  // De grondkleur van Zenit en Stroom verschilt een tikje; de adresbalk gaat mee.
  reapplyTheme();
}

let current: Look = typeof window === 'undefined' ? 'cockpit' : loadLook();
const listeners = new Set<() => void>();

export function setLook(next: Look): void {
  current = next;
  try {
    if (next === 'cockpit') localStorage.removeItem(LOOK_STORAGE_KEY);
    else localStorage.setItem(LOOK_STORAGE_KEY, next);
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
