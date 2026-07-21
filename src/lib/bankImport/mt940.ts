import type { ParsedBankStatement, ParsedBankTransaction } from '../../types';
import { amountToCents } from './dedup';

/** yymmdd -> ISO. Eeuw heuristiek: 70-99 => 19xx, anders 20xx. */
function isoFromYYMMDD(yymmdd: string): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = parseInt(yymmdd.slice(0, 2), 10);
  const year = yy >= 70 ? 1900 + yy : 2000 + yy;
  return `${year}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
}

/**
 * Haalt een SEPA-subveld (/NAME/, /IBAN/, /REMI/, /EREF/) uit een :86:-blok.
 * De waarde loopt door tot het VOLGENDE subveld (`/TAG/`), niet tot de eerstvolgende
 * schuine streep: een omschrijving als `/REMI/FACT 2026/0007` leverde anders
 * "FACT 2026" op, waarmee het factuurnummer — en dus de aflettering — sneuvelde.
 */
function sepaField(block: string, tag: string): string | null {
  const re = new RegExp(`/${tag}/((?:(?!/[A-Z]{2,6}/).)*)`);
  const m = re.exec(block);
  return m ? m[1].trim() || null : null;
}

/**
 * MT940-parser (klassiek SWIFT-afschrift). Leest :61: (transactieregels) en het
 * bijbehorende :86: (omschrijving/tegenpartij). Ondersteunt zowel SEPA-gestructureerde
 * :86:-velden (/NAME/ /IBAN/ /REMI/) als vrije tekst.
 */
export function parseMt940(raw: string, fileName: string): ParsedBankStatement {
  const content = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Splits op tag-grenzen, maar houd vervolgregels (zonder :nn:) bij hun tag.
  const tokens = content.split(/\n(?=:\d{2,3}[A-Z]?:)/).map(t => t.replace(/\n/g, ' ').trim());

  const transactions: ParsedBankTransaction[] = [];
  let pending: ParsedBankTransaction | null = null;
  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  let opening: number | null = null;
  let closing: number | null = null;
  const accounts: string[] = [];

  const balanceCents = (body: string): number | null => {
    // [C|D]yymmddCCYamount  -> bv. C250101EUR1234,56
    const m = /^([CD])(\d{6})([A-Z]{3})([\d.,]+)/.exec(body.trim());
    if (!m) return null;
    const cents = amountToCents(m[4]);
    return m[1] === 'D' ? -cents : cents;
  };

  for (const token of tokens) {
    const tagMatch = /^:(\d{2,3}[A-Z]?):(.*)$/.exec(token);
    if (!tagMatch) continue;
    const tag = tagMatch[1];
    const body = tagMatch[2];

    if (tag === '60F' || tag === '60M') {
      const iso = isoFromYYMMDD(/^[CD](\d{6})/.exec(body.trim())?.[1] ?? '');
      if (iso && !periodStart) periodStart = iso;
      if (opening === null) opening = balanceCents(body);
    } else if (tag === '62F' || tag === '62M') {
      const iso = isoFromYYMMDD(/^[CD](\d{6})/.exec(body.trim())?.[1] ?? '');
      if (iso) periodEnd = iso;
      closing = balanceCents(body);
    } else if (tag === '61') {
      if (pending) { transactions.push(pending); pending = null; }
      // :61: valuedate(6) [entrydate(4)] mark([R]C|[R]D) [fundscode(1 letter)] amount type ref
      // De funds-code (3e teken van de valutacode, bv. 'R' van EUR) is optioneel; het
      // bedrag begint altijd met een cijfer, dus dat onderscheidt funds-code van bedrag.
      const m = /^(\d{6})(\d{4})?(R?[CD])[A-Z]?(\d[\d.,]*)/.exec(body.trim());
      if (!m) continue;
      const valueDate = isoFromYYMMDD(m[1]);
      let bookingDate = valueDate;
      if (m[2]) {
        // entrydate is mmdd; leen het jaar van de valutadatum.
        const year = (valueDate ?? '').slice(0, 4) || String(new Date().getFullYear());
        bookingDate = `${year}-${m[2].slice(0, 2)}-${m[2].slice(2, 4)}`;
      }
      const mark = m[3];
      const credit = mark === 'C' || mark === 'RD'; // RD = storno van een debet => bijschrijving
      const cents = amountToCents(m[4]);
      const refTail = body.trim().slice(m[0].length);
      const bankRef = (/\/\/(\S+)/.exec(refTail)?.[1]) || null;
      pending = {
        booking_date: bookingDate ?? valueDate ?? '',
        value_date: valueDate,
        amount_cents: credit ? cents : -cents,
        currency: 'EUR',
        counterparty_name: null,
        counterparty_iban: null,
        description: null,
        structured_reference: null,
        end_to_end_id: null,
        bank_tx_id: bankRef,
      };
    } else if (tag === '86' && pending) {
      const isSepa = body.includes('/NAME/') || body.includes('/IBAN/') || body.includes('/REMI/');
      if (isSepa) {
        pending.counterparty_name = sepaField(body, 'NAME');
        pending.counterparty_iban = sepaField(body, 'IBAN');
        pending.description = sepaField(body, 'REMI') || body.replace(/\/[A-Z]+\//g, ' ').trim() || null;
        pending.end_to_end_id = sepaField(body, 'EREF');
      } else {
        pending.description = body.trim() || null;
      }
    } else if (tag === '25') {
      // Rekeningnummer van dít afschriftblok. We gebruiken het niet om te boeken
      // (de gebruiker kiest de bankrekening), maar wel om te merken dat er
      // meerdere rekeningen in één bestand zitten — dan klopt de saldo-
      // aansluiting niet en hoort er een waarschuwing bij.
      const acct = body.trim();
      if (acct && !accounts.includes(acct)) accounts.push(acct);
    }
  }
  if (pending) transactions.push(pending);

  const cleaned = transactions.filter(t => t.booking_date && t.amount_cents !== 0);
  if (cleaned.length === 0) {
    throw new Error('Geen transacties (:61:) gevonden in dit MT940-bestand.');
  }

  const warnings: string[] = [];
  const skipped = transactions.length - cleaned.length;
  if (skipped > 0) {
    warnings.push(`${skipped} regel(s) overgeslagen: geen leesbare boekdatum of een bedrag van € 0,00.`);
  }
  if (accounts.length > 1) {
    warnings.push(`Dit bestand bevat afschriften van ${accounts.length} rekeningen (${accounts.join(', ')}). Alle transacties komen op deze ene bankrekening binnen en het begin-/eindsaldo is dat van het eerste afschrift. Exporteer bij voorkeur per rekening.`);
  }

  return {
    format: 'mt940',
    file_name: fileName,
    file_hash: null,
    period_start: periodStart,
    period_end: periodEnd,
    opening_balance_cents: opening,
    closing_balance_cents: closing,
    warnings,
    transactions: cleaned,
  };
}
