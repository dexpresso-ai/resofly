/**
 * Hoe een AI tegen de gebruiker praat: in zijn taal, niet in die van de code.
 *
 * Gerrie en een gekoppelde AI werken met technische namen: tools als
 * `propose_invoice`, handelingen als `inbox.list`, velden als `client_id`,
 * statussen als `draft`. Die hebben ze nodig om iets aan te roepen. Zonder een
 * afspraak lekten ze ook in het antwoord ("ik heb propose_invoice gebruikt",
 * "status: overdue"), en daar heeft een gebruiker niets aan.
 *
 * Eén tekst voor allebei: Gerrie's systeemprompt en de instructies van de
 * MCP-server nemen deze regels letterlijk over. Dit bestand leest geen
 * omgevingsvariabelen, zodat de tests het gewoon kunnen importeren.
 */
export const PLAIN_LANGUAGE_RULES: readonly string[] = [
  'TAAL — praat zoals de gebruiker, niet zoals de code:',
  '- Noem nooit de technische naam van een tool of handeling, zoals propose_invoice, list_invoices of inbox.list. Die namen zijn alleen om iets mee aan te roepen. Zeg in gewone woorden wat je doet: "ik heb een conceptfactuur klaargezet", niet "ik heb propose_invoice gebruikt".',
  '- Noem ook geen veldnamen (client_id, due_date), tabellen of statuscodes (draft, sent, overdue). Vertaal ze: concept, verstuurd, te laat, betaald, geaccepteerd, afgewezen.',
  '- Laat geen interne id\'s zien, zoals de lange codes waarmee iets in de database staat. Noem een factuur bij zijn nummer en een klant bij zijn naam.',
  '- Gaat er iets mis, vertel dan in gewone woorden wat er gebeurde en wat de gebruiker kan doen. Citeer geen technische foutmelding.',
];

/**
 * De technische namen in een tekst die een gebruiker te zien krijgt: tool- en
 * veldnamen met een liggend streepje (`propose_invoice`, `client_id`) en
 * handelingen met een punt (`inbox.list`). Voor de tests: wat een gebruiker
 * leest, hoort er geen te bevatten.
 */
export function technicalNames(text: string): string[] {
  const dotted = /\b[a-z][a-z_]{2,}\.[a-z][a-z_]{2,}\b/g;
  const found = new Set<string>();
  for (const match of text.matchAll(dotted)) found.add(match[0]);
  // Eerst de namen met een punt eruit, anders telt `set_status` in
  // `invoice.set_status` nog een keer los mee.
  for (const match of text.replace(dotted, ' ').matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) found.add(match[0]);
  return [...found];
}
