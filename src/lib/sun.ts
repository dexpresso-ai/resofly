/**
 * De zon boven Nederland: wanneer hij opkomt, op zijn hoogst staat (het zenit)
 * en ondergaat. Voedt het thema "Met de zon mee" en de Dagboog op Vandaag.
 *
 * NOAA-benadering (Spencer-reeks voor de zonnedeclinatie en de tijdvereffening),
 * nauwkeurig tot op een paar minuten. Ruim genoeg om te weten of het dag of nacht
 * is; geen astronomische almanak.
 *
 * Tijden zijn minuten na middernacht in de wandklok van de browser, dus mét
 * zomertijd. Wie een vaste offset nodig heeft (tests, of een andere tijdzone),
 * geeft die mee als `offsetMinutes`.
 *
 * Let op: index.html rekent bij het opstarten met dezelfde formule (zonder
 * import, want dat script draait vóór de bundel). Blijven die twee gelijk.
 */

export interface SunPlace { lat: number; lon: number }
export interface SunTimes {
  /** Zon op, in minuten na middernacht. */
  rise: number;
  /** Het zenit: de zon op zijn hoogst. */
  noon: number;
  /** Zon onder. */
  set: number;
}

/** Utrecht, het midden van het land. Tussen Groningen en Middelburg schuift
 *  zon op/onder hooguit een kwartier; voor dag of nacht maakt dat niet uit. */
export const DEFAULT_SUN_PLACE: SunPlace = { lat: 52.09, lon: 5.12 };

const RAD = Math.PI / 180;

export function sunTimes(date: Date, place: SunPlace = DEFAULT_SUN_PLACE, offsetMinutes = -date.getTimezoneOffset()): SunTimes {
  const dayIndex = Math.round((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(date.getFullYear(), 0, 1)) / 864e5);
  const g = (2 * Math.PI / 365) * dayIndex;
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g)
    + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const lat = place.lat * RAD;
  // 90,833°: de zon "raakt" de horizon inclusief lichtbreking en zijn eigen straal.
  const cosHa = Math.cos(90.833 * RAD) / (Math.cos(lat) * Math.cos(decl)) - Math.tan(lat) * Math.tan(decl);
  const noon = 720 - 4 * place.lon - eqTime + offsetMinutes;
  // Poolnacht (geen zon op) of middernachtzon: dan is het de hele dag nacht of dag.
  if (cosHa >= 1) return { rise: noon, noon, set: noon };
  if (cosHa <= -1) return { rise: 0, noon, set: 1440 };
  const ha = Math.acos(cosHa) / RAD;
  return { rise: noon - 4 * ha, noon, set: noon + 4 * ha };
}

/** Is het op dit moment dag (tussen zon op en zon onder)? */
export function isDaylight(date: Date, place: SunPlace = DEFAULT_SUN_PLACE): boolean {
  const { rise, set } = sunTimes(date, place);
  const minute = date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
  return minute >= rise && minute < set;
}

/** Het eerstvolgende moment waarop het van dag naar nacht gaat (of andersom). */
export function nextSunChange(date: Date, place: SunPlace = DEFAULT_SUN_PLACE): Date {
  const { rise, set } = sunTimes(date, place);
  const minute = date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
  const at = (dayOffset: number, minutes: number) => {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset);
    d.setMinutes(Math.ceil(minutes));
    return d;
  };
  if (minute < rise) return at(0, rise);
  if (minute < set) return at(0, set);
  return at(1, sunTimes(at(1, 0), place).rise);
}

/** "08:15" */
export function formatClock(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
