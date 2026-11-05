// ============================================================
// Foutmeldingen naar buiten: wat de database zei (tabel- en kolomnamen,
// constraints, interne details) is voor het logboek, niet voor de browser of
// een koppeling. Eigen meldingen van de app (Nederlandse zinnen uit triggers en
// functies) gaan ongewijzigd door.
// ============================================================

/**
 * Een foutmelding van een handeling voor buiten. Een handeling meldt "Klant
 * ophalen mislukt: <wat de database zei>"; dat tweede deel is voor ons logboek,
 * niet voor een koppeling (tabel- en kolomnamen, interne details). Wat op een
 * fout in de invoer wijst, blijft een 422 met een zin; wat op een storing wijst,
 * wordt een 500 — dan mag de koppeling het gewoon opnieuw proberen.
 */
export function publicActionError(message: string): { status: 422 | 500; message: string } {
  const text = String(message || '');
  const split = text.match(/^(.*?\bmislukte?):\s*(.+)$/s);
  const [head, tail] = split ? [split[1], split[2]] : ['Dit', text];
  if (!(split ? DATABASE_TEXT : STRONG_DATABASE_TEXT).test(tail)) return { status: 422, message: text };
  if (INPUT_PROBLEM.test(tail)) {
    return { status: 422, message: split ? `${head}: de invoer past niet bij de regels van ResoFly.` : 'De invoer past niet bij de regels van ResoFly.' };
  }
  return { status: 500, message: split ? `${head}.` : 'Er ging iets mis aan onze kant.' };
}

const DATABASE_TEXT = /violates|relation "|column "|syntax error|permission denied|duplicate key|invalid input|statement timeout|canceling statement|could not|does not exist|JWT|PGRST|schema cache|connection|fetch failed|timed? ?out/i;
const STRONG_DATABASE_TEXT = /violates|relation "|column "|duplicate key|invalid input syntax|PGRST|permission denied for|canceling statement/i;
const INPUT_PROBLEM = /violates (check|not-null|unique|foreign key)|duplicate key|invalid input/i;
