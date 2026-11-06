// Een fout uit de database als antwoord voor de gebruiker, en invoer die de
// database nooit kan opslaan.
//
// Een RPC of een tabel-aanroep via supabase-js geeft bij een fout een gewoon
// object terug ({ code, message, details, hint }), geen Error. De functies gooiden
// dat object door, en de algemene foutafhandeling maakte er dan een 500 van met
// "Onbekende fout." in de log. Zo kreeg wie twee keer op Versturen klikte
// "server- of providerfout", terwijl de database netjes zei "er loopt al een
// verzendpoging", en kreeg een bezoeker die een NUL-teken meestuurde een 500.
// Hier wordt zo'n fout een 4xx met de Nederlandse zin uit de database, of
// blijft het een 500 als het echt een fout aan onze kant is.

export type DbErrorAnswer = { status: 403 | 404 | 409 | 422; message: string };

// Meldingen van Postgres zelf (Engels, met tabel- of kolomnamen) gaan nooit naar
// de gebruiker; alleen eigen meldingen uit een functie of trigger (raise … using
// errcode) zijn bedoeld om te tonen.
const TECHNICAL = /violates|relation "|column "|syntax error|does not exist|permission denied for|duplicate key|invalid input|null value|out of range|operator does not exist|could not|unterminated|cannot be converted/i;

export const INVALID_CHARACTER_MESSAGE =
  'Je invoer bevat een teken dat niet kan worden opgeslagen (een onzichtbaar stuurteken). Haal het weg en probeer het opnieuw.';

export const ALREADY_HAPPENING_MESSAGE =
  'Iemand anders was je net voor (een collega, of een dubbele klik). Ververs de pagina en kijk of het al gebeurd is.';

/** De fout als antwoord voor de gebruiker, of null als het een echte serverfout is. */
export function dbErrorAnswer(error: unknown): DbErrorAnswer | null {
  if (!error || typeof error !== 'object') return null;
  const err = error as { code?: unknown; message?: unknown };
  const code = typeof err.code === 'string' ? err.code : '';
  if (!/^[0-9A-Z]{5}$/.test(code)) return null;
  const message = typeof err.message === 'string' ? err.message.trim() : '';
  const own = message !== '' && !TECHNICAL.test(message);

  // \u0000 in tekst of json (22P05), of een ongeldige bytevolgorde (22021).
  if (code === '22P05' || code === '22021') return { status: 422, message: INVALID_CHARACTER_MESSAGE };
  // Unieke sleutel: iets bestond al of gebeurde tegelijk. Een eigen melding
  // ("nummer al in gebruik", "er loopt al een verzendpoging") gaat mee.
  if (code === '23505') return { status: 409, message: own ? message : ALREADY_HAPPENING_MESSAGE };
  if (!own) return null;
  if (code === '23514') return { status: 409, message };
  if (code === '22023' || code === '22001' || code === 'P0001') return { status: 422, message };
  if (code === '42501') return { status: 403, message };
  if (code === '02000') return { status: 404, message };
  return null;
}

/**
 * Zit er ergens in deze invoer (tekst, of tekst diep in een object of lijst) een
 * NUL-teken? Postgres kan dat in tekst en json niet opslaan; vooraf weigeren
 * geeft de bezoeker een duidelijke melding in plaats van een serverfout.
 */
export function containsNulCharacter(value: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (typeof value === 'string') return value.includes('\u0000');
  if (Array.isArray(value)) return value.some((item) => containsNulCharacter(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .some(([key, item]) => key.includes('\u0000') || containsNulCharacter(item, depth + 1));
  }
  return false;
}
