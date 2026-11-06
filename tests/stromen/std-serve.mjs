// Vervangt `serve` uit deno.land/std: in plaats van een server te starten,
// geeft hij de handler aan de harnas (zie functies.mjs), die hem rechtstreeks
// met een Request aanroept.
export function serve(handler) {
  if (typeof globalThis.__stromenServe !== 'function') {
    throw new Error('tests/stromen: serve() aangeroepen buiten de harnas.');
  }
  globalThis.__stromenServe(handler);
}
