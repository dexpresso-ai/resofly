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
  if (message.includes('schema cache')) return true;
  // Bewust de héle zin en niet het losse "does not exist". Postgres gebruikt
  // diezelfde woorden namelijk ook voor een ontbrekende KOLOM (42703) en een
  // ontbrekende FUNCTIE (42883), en dat zijn heel andere gevallen:
  //
  // - Een ontbrekende kolom betekende dat de pagina AI-koppelingen "nog niet
  //   beschikbaar in deze omgeving" toonde terwijl er levende koppelingen
  //   waren — inclusief hun intrekknop, die daarmee onbereikbaar werd.
  // - Een hernoemde kolom in een view maakte een kapotte deploy visueel
  //   identiek aan een ongemigreerde: een rustige regel, een lege lijst, en
  //   niets in de logs.
  //
  // Een ontbrekende tabel of view zegt altijd "relation ... does not exist".
  return /relation\s+\S+\s+does not exist/.test(message);
}

/**
 * Hetzelfde gaatje, maar dan één KOLOM: de app is uitgerold en de migratie die
 * deze kolom toevoegt nog niet gedraaid. Een aanroeper kan dan terugvallen op
 * dezelfde opdracht zónder dat veld, in plaats van de gebruiker een
 * PostgREST-zin voor te schotelen.
 *
 * Bewust mét de kolomnaam erbij, en bewust alleen op de twee foutcodes: een
 * 42703 op een kolom die we hier niet verwachten is een écht kapotte query, en
 * die hoort niet stilletjes te worden opgevangen.
 */
export function isMissingColumn(error: { code?: string; message?: string } | null | undefined, column: string): boolean {
  if (!error) return false;
  // 42703 = undefined_column (Postgres), PGRST204 = onbekend in de schema-cache
  // van PostgREST ("Could not find the 'x' column of 'y' in the schema cache").
  if (error.code !== '42703' && error.code !== 'PGRST204') return false;
  return String(error.message ?? '').toLowerCase().includes(column.toLowerCase());
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
