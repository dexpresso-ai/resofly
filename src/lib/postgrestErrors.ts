/**
 * "Er is iets stuk" versus "dit staat hier nog niet aan".
 *
 * De frontend loopt via Cloudflare Pages vóór op de database: een push rolt de
 * app uit, maar de migratie en de edge functions gaan langs een andere weg. In
 * dat gaatje bestaat een nieuwe tabel of view nog niet, en dan geeft PostgREST
 * een fout waar een gebruiker niets van begrijpt ("Could not find the table …
 * in the schema cache") — in het rood, terwijl er niets mis is.
 *
 * Deze functie herkent dat geval, zodat een scherm er een rustige regel van kan
 * maken die vanzelf verdwijnt zodra de migratie gedraaid heeft. Eén plek, want
 * twee kopieën van zo'n lijstje lopen op den duur uit elkaar.
 */
export function isMissingRelation(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  // 42P01 = undefined_table (Postgres), PGRST205 = onbekend in de schema-cache.
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  const message = String(error.message ?? '').toLowerCase();
  return message.includes('schema cache') || message.includes('does not exist');
}

/**
 * Deze module bestaat in deze omgeving nog niet in de database. Geen fout om
 * rood van te kleuren: de migratie is simpelweg nog niet gedraaid.
 */
export class NotMigratedError extends Error {
  constructor(message = 'Dit onderdeel is in deze omgeving nog niet ingeschakeld.') {
    super(message);
    this.name = 'NotMigratedError';
  }
}
