/**
 * Wat een matchronde deed, in één zin voor het scherm (20261118190000), en het
 * doorgaan in rondes (20261118200000).
 *
 * De matcher koppelt betalingen aan inkoopfacturen en boekt ze meteen als het
 * zeker is. Wie op "Opnieuw matchen" klikt of een afschrift inleest, moet
 * kunnen zien wát er vanzelf geboekt is; anders lijkt het alsof er
 * transacties verdwijnen uit "Af te letteren".
 *
 * Een ronde stopt vóór de tijdgrens van de database (8 seconden voor de app)
 * en geeft dan next_cursor terug: daar gaat de volgende ronde verder. Het
 * scherm en Gerrie laten de rondes vanzelf lopen tot alles is nagelopen
 * (runMatchRounds). Puur rekenwerk, zodat het unit-tests heeft
 * (bankMatch.test.ts).
 */

export interface BankMatchSummaryInput {
  suggested: number;
  auto_booked: number;
  auto_booked_purchase: number;
  merged: number;
  /** Nagelopen in deze ronde(s). */
  processed?: number;
  /** Nog niet nagelopen: de ronde stopte op de tijdgrens. */
  remaining?: number;
  /** Waar de volgende ronde verder moet, of null als alles is nagelopen. */
  next_cursor?: string | null;
}

const count = (n: number, one: string, more: string) => `${n} ${n === 1 ? one : more}`;
const nl = (n: number) => n.toLocaleString('nl-NL');

export function describeMatchResult(res: BankMatchSummaryInput, options: { nothingText?: string | null } = {}): string | null {
  const parts: string[] = [];
  const purchase = Math.max(0, res.auto_booked_purchase);
  const rules = Math.max(0, res.auto_booked - purchase);
  if (purchase > 0) parts.push(`${count(purchase, 'betaling', 'betalingen')} meteen afgeletterd tegen een inkoopfactuur`);
  if (rules > 0) parts.push(`${count(rules, 'transactie', 'transacties')} geboekt met een bankregel`);
  if (res.suggested > 0) parts.push(`${count(res.suggested, 'transactie heeft', 'transacties hebben')} een voorstel`);
  if (res.merged > 0) parts.push(`${count(res.merged, 'bankregel bevestigt', 'bankregels bevestigen')} een mutatie die je zelf invoerde (samengevoegd)`);
  let text = parts.length ? `${parts.join(', ')}.` : null;
  const remaining = Math.max(0, res.remaining ?? 0);
  if (remaining > 0) {
    const rest = `Nog ${nl(remaining)} ${remaining === 1 ? 'transactie' : 'transacties'} niet nagelopen. Klik nog eens op "Opnieuw matchen".`;
    text = text ? `${text} ${rest}` : rest;
  }
  if (!text) return options.nothingText === undefined ? 'Niets nieuws gevonden.' : options.nothingText;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Tijdens de rondes: hoe ver het is. */
export function describeMatchProgress(res: BankMatchSummaryInput): string {
  const done = Math.max(0, res.processed ?? 0);
  const total = done + Math.max(0, res.remaining ?? 0);
  const purchase = Math.max(0, res.auto_booked_purchase);
  return `Bezig met matchen: ${nl(done)} van ${nl(total)} transacties nagelopen${purchase > 0 ? `, ${nl(purchase)} meteen afgeletterd` : ''}…`;
}

/** Twee rondes bij elkaar: de tellers opgeteld, de rest en de cursor van de laatste. */
export function addMatchResults<T extends BankMatchSummaryInput>(a: T, b: T): T {
  return {
    ...b,
    suggested: a.suggested + b.suggested,
    auto_booked: a.auto_booked + b.auto_booked,
    auto_booked_purchase: a.auto_booked_purchase + b.auto_booked_purchase,
    merged: a.merged + b.merged,
    processed: (a.processed ?? 0) + (b.processed ?? 0),
    remaining: b.remaining ?? 0,
    next_cursor: b.next_cursor ?? null,
  };
}

/**
 * Ga door met rondes zolang de database een cursor teruggeeft. Stopt ook na
 * maxRounds (elke ronde duurt hoogstens zo'n 6 seconden) en als een ronde
 * dezelfde cursor teruggeeft (dan schiet het niet op). Geeft het totaal.
 */
export async function runMatchRounds<T extends BankMatchSummaryInput>(
  first: T,
  next: (cursor: string) => Promise<T>,
  options: { maxRounds?: number; onProgress?: (sofar: T) => void } = {},
): Promise<T> {
  const maxRounds = options.maxRounds ?? 20;
  let total = first;
  let rounds = 1;
  while (total.next_cursor && rounds < maxRounds) {
    options.onProgress?.(total);
    const cursor = total.next_cursor;
    const round = await next(cursor);
    total = addMatchResults(total, round);
    rounds += 1;
    if (round.next_cursor === cursor) break;
  }
  return total;
}
