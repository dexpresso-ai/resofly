import type { ParsedBankStatement, ParsedBankTransaction } from '../../types';
import { amountToCents, normalizeDate } from './dedup';

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

/** Kleine letters, leestekens naar spaties, spaties samengevoegd: "Af/Bij" en "Af Bij" worden gelijk. */
function normHeader(h: string): string {
  return h.toLowerCase().replace(/[/_\-.()]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Zoekt een kolom: eerst een EXACTE headermatch, pas daarna een header die de
 * term bevat. Die volgorde is essentieel. ING's tweede kolom heet "Naam /
 * Omschrijving"; met alleen een bevat-match kaapte die de omschrijvingsrol,
 * waardoor "Mededelingen" — de kolom mét het factuurnummer — nooit werd gelezen
 * en automatische aflettering bij ING structureel niets opleverde.
 * Kolommen die al een andere rol hebben (`taken`) worden overgeslagen.
 */
function findCol(headers: string[], terms: string[], taken: number[] = [], exactOnly = false): number {
  const norm = headers.map(normHeader);
  const free = (i: number) => !taken.includes(i);
  for (const term of terms) {
    const idx = norm.findIndex((h, i) => free(i) && h === term);
    if (idx > -1) return idx;
  }
  if (exactOnly) return -1;
  for (const term of terms) {
    const idx = norm.findIndex((h, i) => free(i) && h.includes(term));
    if (idx > -1) return idx;
  }
  return -1;
}

/** Alle nog vrije kolommen die bij een term passen — Rabobank splitst de omschrijving over Omschrijving-1/-2/-3. */
function findAllCols(headers: string[], terms: string[], taken: number[]): number[] {
  const norm = headers.map(normHeader);
  const out: number[] = [];
  norm.forEach((h, i) => {
    if (taken.includes(i)) return;
    if (terms.some(t => h === t || h.includes(t))) out.push(i);
  });
  return out;
}

const IND_DEBIT = /^(af|debet|debit|d|db|dbit|-)$/;
const IND_CREDIT = /^(bij|credit|c|cr|crdt|\+)$/;

/**
 * Generieke CSV-parser voor bankexports. CSV verschilt per bank, dus dit is een
 * ruime best-effort voor de gangbare NL-formaten (Rabobank, ING, ABN AMRO, bunq,
 * Knab). Lukt de herkenning niet, dan volgt een duidelijke fout met het advies om
 * CAMT.053 te gebruiken — dat formaat is gestandaardiseerd én bevat begin- en
 * eindsaldo, waarmee de saldo-aansluiting kan controleren of het bestand compleet is.
 */
export function parseCsv(raw: string, fileName: string): ParsedBankStatement {
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 2) throw new Error('Het CSV-bestand bevat geen transacties.');

  const delim = detectDelimiter(lines[0]);
  const headers = splitLine(lines[0], delim);
  const warnings: string[] = [];

  const dateCol = findCol(headers, ['boekingsdatum', 'transactiedatum', 'boekdatum', 'datum', 'date']);

  // Eerst kijken of er een apart debet- én creditkolom-paar is (exacte headers,
  // anders kaapt 'af' woorden als "afschrijving"). Alleen als béide bestaan is
  // het een paar; anders is er één bedragkolom, eventueel met een Af/Bij-indicator.
  const debitPair = findCol(headers, ['bedrag af', 'af', 'debet', 'debit', 'afschrijving'], [dateCol], true);
  const creditPair = findCol(headers, ['bedrag bij', 'bij', 'credit', 'bijschrijving'], [dateCol, debitPair], true);
  const hasPair = debitPair > -1 && creditPair > -1;

  const debitCol = hasPair ? debitPair : -1;
  const creditCol = hasPair ? creditPair : -1;
  const amountCol = hasPair ? -1 : findCol(headers, ['transactiebedrag', 'bedrag', 'amount', 'mutatie'], [dateCol]);
  const indicatorCol = hasPair ? -1 : findCol(
    headers,
    ['af bij', 'bij af', 'debet credit', 'credit debet', 'debit credit', 'credit debit',
      'mutatiesoort indicator', 'debet of credit', 'indicator', 'dc', 'type'],
    [dateCol, amountCol],
  );

  const claimed = [dateCol, amountCol, debitCol, creditCol, indicatorCol];
  const ibanCol = findCol(headers, ['tegenrekening iban', 'iban tegenpartij', 'counterparty iban', 'tegenrekening', 'iban'], claimed);
  const nameCol = findCol(headers, ['naam tegenpartij', 'naam tegenrekening', 'tegenpartij', 'naam', 'name'], [...claimed, ibanCol]);
  const descCols = findAllCols(
    headers,
    ['mededeling', 'omschrijving', 'description', 'betalingskenmerk', 'memo', 'toelichting'],
    [...claimed, ibanCol, nameCol],
  );

  if (dateCol === -1 || (amountCol === -1 && !hasPair)) {
    throw new Error('Kon de datum- of bedragkolom niet herkennen in dit CSV-bestand. Gebruik bij voorkeur een CAMT.053-export uit je bankportaal.');
  }
  if (descCols.length === 0) {
    warnings.push('Geen omschrijvingskolom herkend — automatisch afletteren op factuurnummer zal niet werken.');
  }

  const transactions: ParsedBankTransaction[] = [];
  let skipped = 0;
  for (let i = 1; i < lines.length; i += 1) {
    const cols = splitLine(lines[i], delim);
    const get = (idx: number): string => (idx > -1 && idx < cols.length ? cols[idx] : '');

    const bookingDate = normalizeDate(get(dateCol));
    if (!bookingDate) { skipped += 1; continue; }

    let cents = 0;
    if (hasPair) {
      const debit = amountToCents(get(debitCol));
      const credit = amountToCents(get(creditCol));
      cents = Math.abs(credit) - Math.abs(debit);
    } else {
      cents = amountToCents(get(amountCol));
      const ind = get(indicatorCol).toLowerCase().trim();
      if (ind && IND_DEBIT.test(ind)) cents = -Math.abs(cents);
      else if (ind && IND_CREDIT.test(ind)) cents = Math.abs(cents);
    }
    if (cents === 0) { skipped += 1; continue; }

    const description = descCols.map(c => get(c)).filter(Boolean).join(' ').trim();

    transactions.push({
      booking_date: bookingDate,
      value_date: null,
      amount_cents: cents,
      currency: 'EUR',
      counterparty_name: get(nameCol) || null,
      counterparty_iban: get(ibanCol) || null,
      description: description || null,
      structured_reference: null,
      end_to_end_id: null,
      bank_tx_id: null,
    });
  }

  if (transactions.length === 0) {
    throw new Error('Geen bruikbare transacties gevonden in dit CSV-bestand.');
  }
  if (skipped > 0) {
    warnings.push(`${skipped} regel(s) overgeslagen: geen leesbare datum of een bedrag van € 0,00.`);
  }
  // Creditcard- en sommige buitenlandse exports zetten élk bedrag positief en
  // geven de richting in een kolom die we niet herkennen. Zonder waarschuwing zou
  // elke aanschaf als ontvangst binnenkomen en tegen verkoopfacturen matchen.
  if (!hasPair && indicatorCol === -1 && transactions.length > 1
      && transactions.every(t => t.amount_cents > 0)) {
    warnings.push('Alle bedragen zijn positief en er is geen Af/Bij-kolom herkend. Controleer of dit klopt — bij een creditcard- of buitenlandse export staan uitgaven dan ten onrechte als ontvangst.');
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
    warnings,
    transactions,
  };
}
