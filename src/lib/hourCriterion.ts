/**
 * Urencriterium (art. 3.6 Wet IB 2001): ten minste 1225 uur per KALENDERJAAR aan
 * de onderneming(en), directe én indirecte uren. Daarnaast moet meer dan de
 * helft van de arbeidstijd naar de onderneming gaan, behalve voor wie in een of
 * meer van de vijf voorgaande kalenderjaren geen ondernemer was (starter). Een
 * starter die halverwege het jaar begint, moet de 1225 uur in dat deel van het
 * jaar halen: er wordt niet naar rato herrekend.
 *
 * Puur rekenwerk, zodat het te testen is (hourCriterion.test.ts).
 */

export const HOUR_CRITERION_MINUTES = 1225 * 60;

const DAY_MS = 86_400_000;

/** ISO-datum (YYYY-MM-DD) naar dagnummer, zonder tijdzone-effecten. */
function dayNumber(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

export interface HourCriterionProjection {
  /** Verwachte uren (in minuten) op 31 december in het huidige tempo. */
  projectedMinutes: number;
  /** Wat er nog ontbreekt tot 1225 uur. */
  remainingMinutes: number;
  /** Gemiddeld nodig per week tot en met 31 december. */
  neededPerWeekMinutes: number;
  /** Dagen na vandaag tot en met 31 december. */
  daysRemaining: number;
}

/**
 * Prognose voor het lopende jaar. Het tempo telt vanaf de eerste geregistreerde
 * dag van het jaar, niet vanaf 1 januari: wie op 1 juli begint, heeft in juni
 * geen achterstand opgebouwd, maar moet de 1225 uur wel vóór 31 december halen.
 */
export function projectHourCriterion(input: {
  totalMinutes: number;
  /** Eerste dag met geregistreerde uren in dit jaar, of null als er niets is. */
  firstEntryDate: string | null;
  /** Vandaag (YYYY-MM-DD). */
  today: string;
  year: number;
}): HourCriterionProjection {
  const yearEnd = dayNumber(`${input.year}-12-31`);
  const today = Math.min(dayNumber(input.today), yearEnd);
  const daysRemaining = Math.max(0, yearEnd - today);
  const remainingMinutes = Math.max(0, HOUR_CRITERION_MINUTES - input.totalMinutes);

  let projectedMinutes = input.totalMinutes;
  if (input.firstEntryDate && input.totalMinutes > 0) {
    const start = Math.max(dayNumber(input.firstEntryDate), dayNumber(`${input.year}-01-01`));
    const elapsedDays = Math.max(1, today - start + 1);
    projectedMinutes = Math.round(input.totalMinutes + (input.totalMinutes / elapsedDays) * daysRemaining);
  }

  const weeksLeft = Math.max(1, daysRemaining / 7);
  return {
    projectedMinutes,
    remainingMinutes,
    neededPerWeekMinutes: Math.round(remainingMinutes / weeksLeft),
    daysRemaining,
  };
}
