import type { ParsedBankAccountSection, ParsedBankStatement, ParsedBankTransaction } from '../../types';
import { compactAccount } from './check.ts';
import { amountToCents } from './dedup.ts';
import { joinMt940Lines, mt940Counterparty, mt940EntryDate, mt940Remittance, mt940SupplementaryIban } from './mt940Fields.ts';

/** yymmdd -> ISO. Eeuw heuristiek: 70-99 => 19xx, anders 20xx. */
function isoFromYYMMDD(yymmdd: string): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = parseInt(yymmdd.slice(0, 2), 10);
  const year = yy >= 70 ? 1900 + yy : 2000 + yy;
  return `${year}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
}

/** De dag na een ISO-datum. */
function dayAfter(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Haalt een SEPA-subveld (/NAME/, /IBAN/, /REMI/, /EREF/) uit een :86:-blok.
 * De waarde loopt door tot het VOLGENDE subveld (`/TAG/`), niet tot de eerstvolgende
 * schuine streep: een omschrijving als `/REMI/FACT 2026/0007` leverde anders
 * "FACT 2026" op, waarmee het factuurnummer — en dus de aflettering — sneuvelde.
 * Het scheidingsteken vóór het volgende subveld (ING: `//EREF/`) en de slot-"/"
 * van het blok horen er niet bij: eerder eindigden omschrijving en
 * end-to-end-id op een "/".
 */
function sepaField(block: string, tag: string): string | null {
  const re = new RegExp(`/${tag}/((?:(?!/[A-Z]{2,6}/).)*)`);
  const m = re.exec(block);
  return m ? m[1].trim().replace(/\/+$/, '').trim() || null : null;
}

interface Section {
  account: string;
  openingDate: string | null;
  opening: number | null;
  closing: number | null;
  closingDate: string | null;
}

/**
 * MT940-parser (klassiek SWIFT-afschrift). Leest :61: (transactieregels) en het
 * bijbehorende :86: (omschrijving/tegenpartij). Ondersteunt zowel SEPA-gestructureerde
 * :86:-velden (/NAME/ /IBAN/ /REMI/) als vrije tekst.
 */
export function parseMt940(raw: string, fileName: string): ParsedBankStatement {
  const content = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Splits op tag-grenzen, maar houd vervolgregels (zonder :nn:) bij hun tag.
  // De regeleinden blijven staan: hoe vervolgregels aan elkaar gaan, hangt af
  // van het veld (zie joinMt940Lines). Een regel "-" sluit een bericht af; wat
  // daarna komt (de kop van het volgende bericht) hoort niet bij de tag.
  const tokens = content.split(/\n(?=:\d{2,3}[A-Z]?:)/).map(t => {
    const lines = t.split('\n');
    const end = lines.findIndex(l => l.trim() === '-');
    return end > -1 ? lines.slice(0, end) : lines;
  });

  const transactions: ParsedBankTransaction[] = [];
  let pending: ParsedBankTransaction | null = null;
  const sections: Section[] = [];
  let current: Section | null = null;
  const section = (): Section => {
    if (!current) { current = { account: '', openingDate: null, opening: null, closing: null, closingDate: null }; sections.push(current); }
    return current;
  };

  const balanceCents = (body: string): number | null => {
    // [C|D]yymmddCCYamount  -> bv. C250101EUR1234,56
    const m = /^([CD])(\d{6})([A-Z]{3})([\d.,]+)/.exec(body.trim());
    if (!m) return null;
    const cents = amountToCents(m[4]);
    return m[1] === 'D' ? -cents : cents;
  };

  for (const lines of tokens) {
    const tagMatch = /^:(\d{2,3}[A-Z]?):(.*)$/.exec((lines[0] ?? '').trimStart());
    if (!tagMatch) continue;
    const tag = tagMatch[1];
    const bodyLines = [tagMatch[2], ...lines.slice(1)];
    const body = bodyLines.join(' ').trim();

    if (tag === '60F' || tag === '60M') {
      const sec = section();
      if (sec.opening === null) {
        sec.opening = balanceCents(body);
        sec.openingDate = isoFromYYMMDD(/^[CD](\d{6})/.exec(body)?.[1] ?? '');
      }
    } else if (tag === '62F' || tag === '62M' || tag === '64' || tag === '65') {
      // Na het eindsaldo hoort niets meer bij de laatste transactie. SWIFT staat
      // een :86: op afschriftniveau toe (ING zet daar /SUM/…); die overschreef de
      // omschrijving van de laatste transactie van elke dag, en daarmee het
      // factuurnummer waarop de matcher koppelt.
      if (pending) { transactions.push(pending); pending = null; }
      if (tag === '64' || tag === '65') continue;
      const sec = section();
      const iso = isoFromYYMMDD(/^[CD](\d{6})/.exec(body)?.[1] ?? '');
      if (iso) sec.closingDate = iso;
      sec.closing = balanceCents(body);
    } else if (tag === '61') {
      if (pending) { transactions.push(pending); pending = null; }
      // :61: valuedate(6) [entrydate(4)] mark([R]C|[R]D) [fundscode(1 letter)] amount type ref
      // De funds-code (3e teken van de valutacode, bv. 'R' van EUR) is optioneel; het
      // bedrag begint altijd met een cijfer, dus dat onderscheidt funds-code van bedrag.
      const m = /^(\d{6})(\d{4})?(R?[CD])[A-Z]?(\d[\d.,]*)/.exec(body);
      if (!m) continue;
      const valueDate = isoFromYYMMDD(m[1]);
      let bookingDate = valueDate;
      if (m[2]) {
        // entrydate is mmdd; het jaar komt van de valutadatum, behalve rond de
        // jaarwisseling (boeking 2 januari bij valuta 31 december).
        bookingDate = mt940EntryDate(valueDate, m[2]);
      }
      const mark = m[3];
      const credit = mark === 'C' || mark === 'RD'; // RD = storno van een debet => bijschrijving
      const cents = amountToCents(m[4]);
      const refTail = body.slice(m[0].length);
      const bankRef = (/\/\/(\S+)/.exec(refTail)?.[1]) || null;
      pending = {
        booking_date: bookingDate ?? valueDate ?? '',
        value_date: valueDate,
        amount_cents: credit ? cents : -cents,
        currency: 'EUR',
        counterparty_name: null,
        // Rabobank zet het IBAN van de tegenpartij op de tweede regel van :61:.
        counterparty_iban: mt940SupplementaryIban(bodyLines.slice(1)),
        description: null,
        structured_reference: null,
        end_to_end_id: null,
        bank_tx_id: bankRef,
        account: section().account || null,
      };
    } else if (tag === '86' && pending) {
      const block = joinMt940Lines(bodyLines);
      const isSepa = block.includes('/NAME/') || block.includes('/IBAN/') || block.includes('/REMI/') || block.includes('/CNTP/');
      if (isSepa) {
        // ING: /CNTP/IBAN/BIC/NAAM/PLAATS/ in plaats van losse /NAME/ en /IBAN/.
        const cntp = mt940Counterparty(block);
        pending.counterparty_name = sepaField(block, 'NAME') ?? cntp.name ?? pending.counterparty_name;
        pending.counterparty_iban = sepaField(block, 'IBAN') ?? cntp.iban ?? pending.counterparty_iban;
        const remi = mt940Remittance(sepaField(block, 'REMI'));
        pending.description = remi.description || block.replace(/\/[A-Z]+\//g, ' ').replace(/\/+$/, '').trim() || null;
        if (remi.structuredReference) pending.structured_reference = remi.structuredReference;
        pending.end_to_end_id = sepaField(block, 'EREF');
      } else {
        pending.description = block || null;
      }
    } else if (tag === '25') {
      // Rekeningnummer van dít afschriftblok. Gaat mee met elke regel, zodat
      // het scherm vóór het inlezen ziet of het bestand bij de gekozen
      // rekening hoort, en bij twee rekeningen alleen de juiste regels inleest
      // met het saldo van die rekening (check.ts).
      if (pending) { transactions.push(pending); pending = null; }
      const account = body.trim();
      current = sections.find(s => compactAccount(s.account) === compactAccount(account)) ?? null;
      if (!current) { current = { account, openingDate: null, opening: null, closing: null, closingDate: null }; sections.push(current); }
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

  // De periode begint de dag ná de datum van :60F:. Volgens SWIFT is dat de
  // datum van het vorige eindsaldo, dus de vorige boekdag. Eerder telde die dag
  // mee: de afschriftcontrole telde dan de mutaties van het vorige afschrift
  // erbij, en elk volgend ING-afschrift gaf vals alarm ("er ontbreken
  // transacties", ook in de aansluiting). Een bank die op :60F: de eerste dag
  // van het afschrift zelf zet, vangen we op met de vroegste mutatie.
  const accounts: ParsedBankAccountSection[] = sections.map(sec => {
    const dates = cleaned.filter(t => compactAccount(t.account) === compactAccount(sec.account)).map(t => t.booking_date).sort();
    const starts = [sec.openingDate ? dayAfter(sec.openingDate) : null, dates[0] ?? null].filter((d): d is string => !!d).sort();
    return {
      account: sec.account,
      period_start: sec.openingDate ? starts[0] : null,
      period_end: sec.closingDate,
      opening_balance_cents: sec.opening,
      closing_balance_cents: sec.closing,
    };
  });
  const main = accounts[0] ?? null;

  return {
    format: 'mt940',
    file_name: fileName,
    file_hash: null,
    period_start: main?.period_start ?? null,
    period_end: main?.period_end ?? null,
    opening_balance_cents: main?.opening_balance_cents ?? null,
    closing_balance_cents: main?.closing_balance_cents ?? null,
    warnings,
    transactions: cleaned,
    accounts: accounts.filter(a => a.account),
  };
}
