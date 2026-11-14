// Vegen op een aanraakscherm: wanneer is een vingerbeweging een veeg, en
// bladert hij dan door? Zonder React, zodat het in node te testen is. De
// lightbox van de galerij (GalleryViewer) gebruikt dit om met een vinger naar
// de volgende of vorige foto te gaan; daarvoor kon dat alleen met de pijltjes,
// en die zijn op een telefoon klein en zitten aan de rand van het scherm.

/**
 * Zo ver mag een vinger bewegen voordat we een richting kiezen. Daaronder is
 * het een tik: een vinger ligt nooit helemaal stil, en een tik op de zwarte
 * rand moet de foto gewoon sluiten.
 */
export const SWIPE_SLOP_PX = 8;

/** Vanaf deze snelheid (px per ms) is een korte veeg een bewuste zwiep. */
const FLICK_SPEED = 0.35;
/** Over zoveel ms aan het eind van de veeg meten we de snelheid. */
const FLICK_WINDOW_MS = 100;
/** Zo lang stil vóór het loslaten, en de vinger zwiepte niet meer maar hield stil. */
const STOPPED_BEFORE_RELEASE_MS = 50;

export type SwipeAxis = 'x' | 'y';
export type SwipeSample = { x: number; t: number };

/** De richting van de beweging, of `null` zolang de vinger nog binnen de dode zone ligt. */
export function swipeAxis(dx: number, dy: number, slop = SWIPE_SLOP_PX): SwipeAxis | null {
  if (Math.hypot(dx, dy) < slop) return null;
  return Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
}

/**
 * Horizontale snelheid aan het eind van de veeg, in px per ms (negatief =
 * naar links). Bewust over de laatste 100 ms en niet vanaf het begin: wie
 * eerst even stil houdt en dan wegzwiept, zou met een gemiddelde over de hele
 * veeg te traag lijken.
 *
 * `samples` zijn de bewegingen, niet het loslaten: dat meldt de plek van de
 * laatste beweging, maar later. Telde het mee, dan drukte die extra tijd de
 * snelheid en bleef een vlotte zwiep van 50 px liggen. `releasedAt` dient
 * alleen om te zien of de vinger vóór het loslaten al stillag.
 */
export function swipeVelocity(samples: SwipeSample[], releasedAt?: number, windowMs = FLICK_WINDOW_MS): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  if (releasedAt != null && releasedAt - last.t > STOPPED_BEFORE_RELEASE_MS) return 0;
  // Het oudste punt dat nog binnen het venster valt. Lag de vinger daarvoor
  // stil (geen punten), dan is de snelheid 0: wie stilhoudt, zwiept niet.
  let first = last;
  for (let i = samples.length - 2; i >= 0; i--) {
    if (last.t - samples[i].t > windowMs) break;
    first = samples[i];
  }
  const ms = last.t - first.t;
  return ms > 0 ? (last.x - first.x) / ms : 0;
}

/**
 * Bladert deze veeg door? `1` = volgende (vinger naar links), `-1` = vorige
 * (vinger naar rechts), `0` = terugveren naar de foto die er al stond.
 *
 * Twee manieren tellen: ver genoeg slepen (een vijfde van het scherm, op een
 * breed scherm hooguit 120 px), of kort en snel wegzwiepen. Alleen de afstand
 * eisen voelde traag: een korte vlotte veeg — zoals iedereen in de
 * fotobibliotheek van zijn telefoon doet — deed dan niets. En wie de foto ver
 * wegsleept maar hem op het laatst terugzwiept, wil blijven waar hij was.
 */
export function swipeStep({ dx, dy, velocity, width }: {
  /** Horizontale verplaatsing in px sinds de aanraking; negatief = naar links. */
  dx: number;
  dy: number;
  /** Snelheid aan het eind, uit swipeVelocity. */
  velocity: number;
  /** Breedte van het vlak waarover geveegd wordt. */
  width: number;
}): -1 | 0 | 1 {
  const distance = Math.abs(dx);
  // Meer op en neer dan opzij: dat is geen bladerbeweging.
  if (distance <= Math.abs(dy)) return 0;
  const direction = dx < 0 ? 1 : -1;
  if (Math.abs(velocity) >= FLICK_SPEED) {
    // Teruggezwiept: de vinger gaat aan het eind de andere kant op.
    if (Math.sign(velocity) !== Math.sign(dx)) return 0;
    if (distance >= 30) return direction;
  }
  return distance >= Math.min(120, Math.max(40, width * 0.2)) ? direction : 0;
}
