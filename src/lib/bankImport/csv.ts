import type { ParsedBankStatement, ParsedBankTransaction } from '../../types';
import { amountToCents, finalizeDedupKeys, normalizeDate } from './dedup';

/** Splitst één CSV-regel met respect voor quotes. */
function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i += 1; }
      else inQuotes = !inQuotes;
    } else if (ch === delim && !inQuotes) {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim().replace(/^"|"$/g, ''));
}

function detectDelimiter(headerLine: string): string {
  const counts: Record<string, number> = {
    ';': (headerLine.match(/;/g) || []).length,
    ',': (headerLine.match(/,/g) || []).length,
    '\t': (headerLine.match(/\t/g) || []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] || ',';
}

/** Vindt de eerste kolomindex waarvan de header één van de termen bevat. */
function findCol(headers: string[], terms: string[]): number {
  const lower = headers.map(h => h.toLowerCase());
  for (const term of terms) {
    const idx = lower.findIndex(h => h.includes(term));
    if (idx > -1) return idx;
  }
  return -1;
}

/**
 * Generieke CSV-parser voor bankexports. CSV is per bank verschillend, dus dit is
 * een ruime best-effort: we herkennen de gangbare kolomnamen (Rabobank, ING, ABN
 * AMRO, bunq, Knab) — datum, bedrag (of debet/credit + Af/Bij-indicator), tegen-
 * rekening, naam en omschrijving. Lukt herkenning niet, dan een duidelijke fout
 * met het advies om CAMT.053 te gebruiken.
 */
export function parseCsv(raw: string, fileName: string): ParsedBankStatement {
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 2) throw new Error('Het CSV-bestand bevat geen transacties.');

  const delim = detectDelimiter(lines[0]);
  const headers = splitLine(lines[0], delim);

  const dateCol = findCol(headers, ['boekingsdatum', 'transactiedatum', 'datum', 'date', 'boekdatum']);
  const amountCol = findCol(headers, ['bedrag', 'amount', 'transactiebedrag', 'mutatie']);
  const debitCol = findCol(headers, ['debet', 'af', 'debit']);
  const creditCol = findCol(headers, ['credit', 'bij']);
  const indicatorCol = findCol(headers, ['af bij', 'af/bij', 'debet/credit', 'debit/credit', 'bij/af', 'mutatiesoort indicator', 'credit/debet']);
  const ibanCol = findCol(headers, ['tegenrekening iban', 'tegenrekening', 'iban tegenpartij', 'counterparty iban', 'tegenrekening (iban)', 'naam / omschrijving tegenrekening']);
  const nameCol = findCol(headers, ['naam tegenpartij', 'tegenpartij', 'naam tegenrekening', 'name', 'naam']);
  const descCol = findCol(headers, ['omschrijving', 'mededelingen', 'mededeling', 'description', 'omschrijving-1', 'betalingskenmerk']);
  const refCol = findCol(headers, ['transactiereferentie', 'volgnr', 'transactie-id', 'transaction id', 'reference']);

  if (dateCol === -1 || (amountCol === -1 && debitCol === -1 && creditCol === -1)) {
    throw new Error('Kon de datum- of bedragkolom niet herkennen in dit CSV-bestand. Gebruik bij voorkeur een CAMT.053-export uit je bankportaal.');
  }

  const transactions: ParsedBankTransaction[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = splitLine(lines[i], delim);
    const get = (idx: number): string => (idx > -1 && idx < cols.length ? cols[idx] : '');

    const bookingDate = normalizeDate(get(dateCol));
    if (!bookingDate) continue;

    let cents = 0;
    if (amountCol > -1) {
      cents = amountToCents(get(amountCol));
      const ind = get(indicatorCol).toLowerCase();
      if (ind && cents > 0 && /^(af|debet|debit|d)$/.test(ind)) cents = -cents;
      else if (ind && cents < 0 && /^(bij|credit|c)$/.test(ind)) cents = Math.abs(cents);
    } else {
      const debit = debitCol > -1 ? amountToCents(get(debitCol)) : 0;
      const credit = creditCol > -1 ? amountToCents(get(creditCol)) : 0;
      cents = Math.abs(credit) - Math.abs(debit);
    }
    if (cents === 0) continue;

    transactions.push({
      dedup_key: '',
      booking_date: bookingDate,
      value_date: null,
      amount_cents: cents,
      currency: 'EUR',
      counterparty_name: get(nameCol) || null,
      counterparty_iban: get(ibanCol) || null,
      description: get(descCol) || null,
      structured_reference: null,
      end_to_end_id: null,
      bank_tx_id: get(refCol) || null,
    });
  }

  if (transactions.length === 0) {
    throw new Error('Geen bruikbare transacties gevonden in dit CSV-bestand.');
  }

  const dates = transactions.map(t => t.booking_date).sort();
  return {
    format: 'csv',
    file_name: fileName,
    file_hash: null,
    period_start: dates[0] ?? null,
    period_end: dates[dates.length - 1] ?? null,
    opening_balance_cents: null,
    closing_balance_cents: null,
    transactions: finalizeDedupKeys(transactions),
  };
}
