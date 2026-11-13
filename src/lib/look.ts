import { useCallback, useSyncExternalStore } from 'react';
import { reapplyTheme } from './theme';

/**
 * De look van de werkruimte.
 *
 *  - 'baken'   de standaard sinds 2026-11-06: de opbouw en de contrasten van
 *              Value Backlog in het merk van ResoFly (CHANGELOG_BAKEN_2026-11-06.md).
 *              Sinds 2026-11-13 met de rail en het uitklappaneel van Zenit
 *              (CHANGELOG_BAKEN_SUBMENU_LINKS_2026-11-13.md).
 *  - 'cockpit' de vorige standaard (Belicht met de Cockpit-laag van 2026-10-05).
 *  - 'zenit'   de voorkant uit het designvoorstel van 2026-10-22
 *              (DESIGN_VOORSTEL_ZENIT_2026-10-22.md).
 *  - 'stroom'  die van 2026-10-30 (DESIGN_VOORSTEL_STROOM_2026-10-30.md).
 *
 * Wie niets kiest, krijgt Baken. Cockpit, Zenit en Stroom blijven kiesbaar in
 * het accountmenu (Weergave), per gebruiker en per browser.
 *
 * Elke look hangt aan een attribuut op <html>, zodat zijn regels alleen gelden
 * zolang hij aan staat:
 *  - Baken: `data-look="baken"` (src/styles/baken.css). De vorm van de rail
 *    en het paneel deelt Baken met Zenit (zenit.css, §4–7); de kleuren staan
 *    in baken.css;
 *  - Zenit: `data-look="zenit"` (src/styles/zenit.css);
 *  - Stroom: `data-look="zenit"` én `data-stroom` (src/styles/stroom.css). Stroom
 *    bouwt op Zenit: dezelfde rail, hetzelfde contextpaneel, dezelfde rustige
 *    onderdelen. Elke regel die Zenit krijgt, geldt dan vanzelf voor Stroom.
 *  - Cockpit: geen attribuut. Baken legt zijn laag óver Cockpit heen, dus alles
 *    wat Baken niet zelf regelt, blijft van Cockpit.
 *
 * Tot 2026-11-06 was Cockpit de standaard en stond er voor Cockpit niets in de
 * opslag. Dat lege vak betekent nu Baken; wie Cockpit kiest, krijgt 'cockpit'
 * in de opslag.
 */
export type Look = 'baken' | 'cockpit' | 'zenit' | 'stroom';

/** Zelfde sleutel als het bootstrap-script in index.html, dat `data-look` al
 *  vóór de eerste verf zet. Die twee MOETEN gelijk blijven. */
export const LOOK_STORAGE_KEY = 'resofly.look';

/** Zenit of Stroom: geen titelbalk en de rustige onderdelen. Baken en Cockpit
 *  vallen erbuiten. */
export function isZenitFamily(look: Look): boolean {
  return look === 'zenit' || look === 'stroom';
}

/** De navigatie: een smalle rail met links ernaast het paneel waarin het
 *  submenu van de module uitklapt (ZenitNav). Sinds 2026-11-13 ook in Baken;
 *  daarvoor had Baken de zijbalk van Cockpit, waarin een submenu als een
 *  harmonica tussen de andere regels openklapte en de rest naar beneden duwde.
 *  Alleen Cockpit houdt die zijbalk (Sidebar). */
export function usesRailNav(look: Look): boolean {
  return look !== 'cockpit';
}

/** Leest de look uit de opslag. Een onbekende of lege waarde is Baken, net als
 *  in het bootstrap-script in index.html. */
export function readStoredLook(storage: Pick<Storage, 'getItem'> | null): Look {
  try {
    const stored = storage?.getItem(LOOK_STORAGE_KEY);
    return stored === 'cockpit' || stored === 'zenit' || stored === 'stroom' ? stored : 'baken';
  } catch {
    return 'baken';
  }
}

export function loadLook(): Look {
  try {
    return readStoredLook(localStorage);
  } catch {
    return 'baken';
  }
}

export function applyLook(look: Look): void {
  const root = document.documentElement;
  if (isZenitFamily(look)) root.setAttribute('data-look', 'zenit');
  else if (look === 'baken') root.setAttribute('data-look', 'baken');
  else root.removeAttribute('data-look');
  if (look === 'stroom') root.setAttribute('data-stroom', '');
  else root.removeAttribute('data-stroom');
  // De grondkleur verschilt per look een tikje; de adresbalk gaat mee.
  reapplyTheme();
}

let current: Look = typeof window === 'undefined' ? 'baken' : loadLook();
const listeners = new Set<() => void>();

export function setLook(next: Look): void {
  current = next;
  try {
    if (next === 'baken') localStorage.removeItem(LOOK_STORAGE_KEY);
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
  const look = useSyncExternalStore(subscribe, () => current, () => 'baken' as Look);
  const set = useCallback((next: Look) => setLook(next), []);
  return [look, set];
}
