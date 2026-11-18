/**
 * Wat een matchronde deed, in één zin voor het scherm (20261118190000).
 *
 * De matcher koppelt betalingen aan inkoopfacturen en boekt ze meteen als het
 * zeker is. Wie op "Opnieuw matchen" klikt of een afschrift inleest, moet
 * kunnen zien wát er vanzelf geboekt is; anders lijkt het alsof er
 * transacties verdwijnen uit "Af te letteren". Puur rekenwerk, zodat het
 * unit-tests heeft (bankMatch.test.ts).
 */

export interface BankMatchSummaryInput {
  suggested: number;
  auto_booked: number;
  auto_booked_purchase: number;
  auto_book_pending: number;
  merged: number;
}

const count = (n: number, one: string, more: string) => `${n} ${n === 1 ? one : more}`;

export function describeMatchResult(res: BankMatchSummaryInput, options: { nothingText?: string | null } = {}): string | null {
  const parts: string[] = [];
  const purchase = Math.max(0, res.auto_booked_purchase);
  const rules = Math.max(0, res.auto_booked - purchase);
  if (purchase > 0) parts.push(`${count(purchase, 'betaling', 'betalingen')} meteen afgeletterd tegen een inkoopfactuur`);
  if (rules > 0) parts.push(`${count(rules, 'transactie', 'transacties')} geboekt met een bankregel`);
  if (res.suggested > 0) parts.push(`${count(res.suggested, 'transactie heeft', 'transacties hebben')} een voorstel`);
  if (res.merged > 0) parts.push(`${count(res.merged, 'bankregel bevestigt', 'bankregels bevestigen')} een mutatie die je zelf invoerde (samengevoegd)`);
  let text = parts.length ? `${parts.join(', ')}.` : null;
  if (res.auto_book_pending > 0) {
    const pending = `${count(res.auto_book_pending, 'zekere koppeling is', 'zekere koppelingen zijn')} nog niet geboekt omdat er veel tegelijk binnenkwam. Klik nog eens op "Opnieuw matchen".`;
    text = text ? `${text} ${pending}` : pending;
  }
  if (!text) return options.nothingText === undefined ? 'Niets nieuws gevonden.' : options.nothingText;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
