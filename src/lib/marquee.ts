/**
 * Selectiekader ("rubber band") in de verkenner, zoals in de Verkenner van Windows:
 * druk op een lege plek, sleep, en alles wat het kader raakt is geselecteerd.
 *
 * Alleen de rekenregels wonen hier — geen DOM, geen React — zodat ze te testen
 * zijn: welke rijen het kader raakt, wat Shift en Ctrl met de bestaande selectie
 * doen, en wanneer een klik een sleep wordt.
 */

export type Point = { x: number; y: number };
export type Box = { left: number; top: number; right: number; bottom: number };

/** Het kader tussen het startpunt en de muis, ongeacht in welke richting je sleept. */
export function marqueeBox(start: Point, current: Point): Box {
  return {
    left: Math.min(start.x, current.x),
    top: Math.min(start.y, current.y),
    right: Math.max(start.x, current.x),
    bottom: Math.max(start.y, current.y),
  };
}

/** Raken twee vlakken elkaar? Alleen een rand delen telt niet. */
export function boxesIntersect(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** De sleutels van de rijen (of tegels) die het kader raakt, in lijstvolgorde. */
export function hitKeys(box: Box, targets: ReadonlyArray<{ key: string; box: Box }>): string[] {
  return targets.filter(target => boxesIntersect(box, target.box)).map(target => target.key);
}

export type MarqueeMode = 'replace' | 'add' | 'toggle';

/** Windows: gewoon slepen vervangt de selectie, Shift voegt toe, Ctrl (of ⌘) schakelt om. */
export function marqueeMode(modifiers: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): MarqueeMode {
  if (modifiers.ctrlKey || modifiers.metaKey) return 'toggle';
  if (modifiers.shiftKey) return 'add';
  return 'replace';
}

/**
 * De nieuwe selectie: wat het kader raakt, gecombineerd met wat er bij het begin
 * van de sleep al aanstond. Altijd vanuit dat uitgangspunt berekend, zodat een
 * rij die het kader in- en weer uitloopt netjes terugvalt op zijn oude stand.
 */
export function combineMarquee(base: ReadonlySet<string>, hits: ReadonlyArray<string>, mode: MarqueeMode): Set<string> {
  if (mode === 'replace') return new Set(hits);
  const next = new Set(base);
  for (const key of hits) {
    if (mode === 'add' || !next.has(key)) next.add(key);
    else next.delete(key);
  }
  return next;
}

/** Een druk op de muis is pas een sleep als de muis ver genoeg beweegt; anders is het een klik op lege ruimte. */
export const MARQUEE_THRESHOLD = 4;

export function passedThreshold(start: Point, current: Point, threshold = MARQUEE_THRESHOLD): boolean {
  return Math.abs(current.x - start.x) >= threshold || Math.abs(current.y - start.y) >= threshold;
}

/**
 * Automatisch scrollen als je tegen de rand aan sleept: hoe dichter bij (of hoe
 * verder voorbij) de rand, hoe sneller — met een plafond, zodat de lijst niet
 * wegschiet. Negatief = omhoog, positief = omlaag, 0 = niets doen.
 */
export function edgeScrollSpeed(position: number, start: number, end: number, margin = 24, max = 18): number {
  if (position < start + margin) return -Math.min(max, Math.ceil((start + margin - position) / 3));
  if (position > end - margin) return Math.min(max, Math.ceil((position - (end - margin)) / 3));
  return 0;
}

/** Houd het kader binnen de inhoud, anders groeit de lijst mee met het kader en scrollt hij zichzelf weg. */
export function clampPoint(point: Point, bounds: { width: number; height: number }): Point {
  return {
    x: Math.max(0, Math.min(point.x, bounds.width)),
    y: Math.max(0, Math.min(point.y, bounds.height)),
  };
}
