/**
 * Losse hulpjes voor de MT940-parser, zonder imports: zo zijn ze met
 * `node --test` te testen (src/lib/mt940Fields.test.ts).
 */

/**
 * De boekdatum in :61: is alleen mmdd; het jaar komt van de valutadatum. Rond
 * de jaarwisseling ligt de boekdatum soms in het andere jaar: valuta 31-12-2025
 * met boekdatum 0102 is 2 januari 2026, en valuta 02-01-2026 met boekdatum
 * 1231 is 31 december 2025. Meer dan een half jaar verschil in maand = ander jaar.
 */
export function mt940EntryDate(valueDateIso: string | null, entryMmdd: string): string | null {
  if (!/^\d{4}$/.test(entryMmdd)) return valueDateIso;
  const month = Number(entryMmdd.slice(0, 2));
  const day = Number(entryMmdd.slice(2, 4));
  if (month < 1 || month > 12 || day < 1 || day > 31) return valueDateIso;
  let year = valueDateIso ? Number(valueDateIso.slice(0, 4)) : new Date().getFullYear();
  if (valueDateIso) {
    const valueMonth = Number(valueDateIso.slice(5, 7));
    if (month - valueMonth > 6) year -= 1;
    else if (valueMonth - month > 6) year += 1;
  }
  return `${year}-${entryMmdd.slice(0, 2)}-${entryMmdd.slice(2, 4)}`;
}

/**
 * ING zet de tegenpartij in :86: als /CNTP/IBAN/BIC/NAAM/PLAATS/. Dat is één
 * subveld met vier delen gescheiden door een schuine streep, dus het algemene
 * subveldpatroon leest het niet.
 */
export function mt940Counterparty(block: string): { iban: string | null; name: string | null } {
  const index = block.indexOf('/CNTP/');
  if (index < 0) return { iban: null, name: null };
  const parts = block.slice(index + '/CNTP/'.length).split('/');
  const iban = (parts[0] ?? '').replace(/\s+/g, '').trim() || null;
  const name = (parts[2] ?? '').trim() || null;
  return { iban, name };
}

/**
 * /REMI/ bij ING begint met de soort: USTD (vrije tekst) of STRD (gestructureerd,
 * bijv. STRD/CUR/1234567890123456). Zonder die voorvoegsels blijft de echte
 * omschrijving (met het factuurnummer) over.
 */
export function mt940Remittance(remi: string | null): { description: string | null; structuredReference: string | null } {
  if (!remi) return { description: null, structuredReference: null };
  const structured = /^STRD\/(?:CUR|ISO)?\/?([^/]+)/.exec(remi);
  if (structured) return { description: remi, structuredReference: structured[1].trim() || null };
  const text = remi.replace(/^USTD\/\/?/, '').trim();
  return { description: text || null, structuredReference: null };
}
