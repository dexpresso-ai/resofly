import type { ParsedBankStatement } from '../../types';
import { parseCamt053 } from './camt053';
import { parseMt940 } from './mt940';
import { parseCsv } from './csv';
import { cyrb53 } from './dedup';

/**
 * Leest een bankbestand in en herkent het formaat (CAMT.053 / MT940 / CSV) aan de
 * bestandsnaam en de inhoud. Geeft een genormaliseerd afschrift terug dat
 * importBankTransactions rechtstreeks naar de database kan sturen.
 */
export async function parseBankFile(file: File): Promise<ParsedBankStatement> {
  const text = await file.text();
  const name = file.name.toLowerCase();
  const head = text.slice(0, 4000);

  const looksXml = /<\?xml/i.test(head) || /<Document[\s>]/i.test(head) || /<BkToCstmrStmt>/i.test(head);
  const looksMt940 = /(^|\n):20:/.test(text) && /(^|\n):61:/.test(text);

  let statement: ParsedBankStatement;
  if (name.endsWith('.xml') || looksXml) {
    statement = parseCamt053(text, file.name);
  } else if (name.endsWith('.940') || name.endsWith('.sta') || name.endsWith('.mt940') || looksMt940) {
    statement = parseMt940(text, file.name);
  } else {
    statement = parseCsv(text, file.name);
  }

  // Een lichte bestands-hash zodat de UI een dubbele upload van exact hetzelfde
  // bestand kan herkennen (los van de per-transactie dedup).
  statement.file_hash = cyrb53(text);
  return statement;
}

export { parseCamt053, parseMt940, parseCsv };
