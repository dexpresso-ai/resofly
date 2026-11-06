// "Vandaag" in Nederland, voor de edge functions.
//
// De edge functions draaien in UTC. Rekenen met new Date() en setHours(0, 0, 0, 0)
// gaf daar de UTC-dag: tussen middernacht en 01:00 (winter) of 02:00 (zomer)
// was het in de functie nog gisteren. De database rekent wél met Nederlandse
// tijd. Zo kon een offerte of contract dat gisteren verliep nog worden
// verstuurd (de functie: niet verlopen) en daarna niet worden geaccepteerd of
// getekend (de database: verlopen); de publieke pagina toonde een akkoordknop
// die een 500 gaf. Alle "is deze datum voorbij"-vragen gaan nu hierlangs.

const NL_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Amsterdam',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** De kalenderdag in Nederland (JJJJ-MM-DD) op dit moment, of op `at`. */
export function amsterdamToday(at: Date = new Date()): string {
  return NL_DATE.format(at);
}

/**
 * Ligt `value` (JJJJ-MM-DD, of een tijdstempel waarvan de eerste tien tekens de
 * datum zijn) vóór vandaag in Nederland? Een lege of onleesbare datum is nooit
 * voorbij.
 */
export function isBeforeAmsterdamToday(value: string | null | undefined, at: Date = new Date()): boolean {
  const day = String(value ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  return day < amsterdamToday(at);
}
