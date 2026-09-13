/**
 * Tijdzone-rekenwerk dat meer dan één plek nodig heeft.
 *
 * De routines-runner berekent hiermee de volgende run ("elke maandag 08:00 in
 * Europe/Amsterdam"); de beslislijst (Fase 1) straks het moment van de dagelijkse
 * veegronde. Twee kopieën van dezelfde DST-rekensom lopen ooit uit de pas, en dat
 * merk je precies één nacht per half jaar. Daarom hier, zonder Deno-afhankelijkheden,
 * zodat node de test ernaast kan draaien.
 */

/** Verschil (ms) tussen de wandklok in `tz` en UTC op instant `at`; positief oostelijk van Greenwich. */
export function tzOffsetMs(tz: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(at)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour === '24' ? '0' : p.hour), +p.minute, +p.second);
  return asUTC - at.getTime();
}

/** Lokale kalenderdatum (in tz) van een UTC-instant. */
export function localYmd(tz: string, at: Date): { y: number; m: number; d: number } {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(at).split('-').map(Number);
  return { y, m, d };
}

/** Wandkloktijd `y-m-d hh:mm` in `tz` → echte UTC-Date (DST-bewust). */
export function wallToUtc(tz: string, y: number, m: number, d: number, hh: number, mm = 0): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offset = tzOffsetMs(tz, new Date(guess));
  return new Date(guess - offset);
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
