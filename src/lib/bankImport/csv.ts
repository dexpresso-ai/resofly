import type { ParsedBankStatement, ParsedBankTransaction } from '../../types';
import { amountToCents, normalizeDate } from './dedup.ts';
import { parseHeaderlessBankFile } from './headerless.ts';

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

// Boekdatum vóór transactiedatum: de koppeling en CAMT werken met de
// boekdatum. Knab heeft beide; een pinbetaling van 31-10, geboekt op 2-11,
// stond eerder op 31-10. Na een overstap naar de koppeling stond dezelfde
// betaling dan op twee datums, en de dubbel-herkenning (zelfde datum) zag hem
// niet. Revolut: "Date completed" vóór "Date started" (zie hieronder).
const DATE_TERMS = ['boekingsdatum', 'boekdatum', 'transactiedatum', 'datum', 'date completed', 'completed date', 'date'];
// "Total amount" (Revolut Business) is het bedrag mét kosten; "Amount" zonder.
const AMOUNT_TERMS = ['transactiebedrag', 'bedrag', 'total amount', 'amount', 'mutatie'];

// Wat een bank in een statuskolom zet. Alleen "voltooid" staat echt op de
// rekening; een post in behandeling verandert nog of verdwijnt, en een
// teruggedraaide of geweigerde betaling is er nooit geweest.
const STATE_DONE = new Set(['completed', 'complete', 'booked', 'settled', 'geboekt', 'voltooid', 'uitgevoerd']);
const STATE_NOT_DONE = new Set(['pending', 'reverted', 'declined', 'failed', 'cancelled', 'canceled', 'in behandeling', 'geweigerd', 'teruggedraaid', 'mislukt', 'geannuleerd']);

const looksLikeIban = (v: string) => /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(v.replace(/\s+/g, '').toUpperCase());
// De eigen rekening: een IBAN (met of zonder valuta erachter), een oud
// rekeningnummer, of het nummer van een ING-spaarrekening (V12345678).
const looksLikeOwnAccount = (v: string) => {
  const s = v.replace(/\s+/g, '').toUpperCase();
  return /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s) || /^[A-Z]?\d{6,12}$/.test(s);
};

/**
 * Een datum met tijd in UTC als kalenderdatum in Nederland. Revolut zet de
 * tijd in UTC: een pinbetaling om 00:30 Nederlandse tijd op 2 november stond
 * eerder op 1 november (en in een ander kwartaal, op 1 januari).
 */
function utcToAmsterdamDate(raw: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw.trim());
  if (!m) return normalizeDate(raw);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  if (!Number.isFinite(ms)) return normalizeDate(raw);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ms));
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return normalizeDate(`${part('year')}-${part('month')}-${part('day')}`);
}

/**
 * De kolommen van een kopregel. Ook gebruikt om de kopregel te vinden: de
 * eerste regel met een datum- én een bedragkolom.
 */
function headerRoles(headers: string[]) {
  const dateCol = findCol(headers, DATE_TERMS);
  // Eerst kijken of er een apart debet- én creditkolom-paar is (exacte headers,
  // anders kaapt 'af' woorden als "afschrijving"). Alleen als béide bestaan is
  // het een paar; anders is er één bedragkolom, eventueel met een Af/Bij-indicator.
  const debitPair = findCol(headers, ['bedrag af', 'af', 'debet', 'debit', 'afschrijving'], [dateCol], true);
  const creditPair = findCol(headers, ['bedrag bij', 'bij', 'credit', 'bijschrijving'], [dateCol, debitPair], true);
  const hasPair = debitPair > -1 && creditPair > -1;
  const amountCol = hasPair ? -1 : findCol(headers, AMOUNT_TERMS, [dateCol]);
  return { dateCol, debitPair, creditPair, hasPair, amountCol, ok: dateCol > -1 && (hasPair || amountCol > -1) };
}

/**
 * Generieke CSV-parser voor bankexports. CSV verschilt per bank, dus dit is een
 * ruime best-effort voor de gangbare NL-formaten (Rabobank, ING, ABN AMRO, bunq,
 * Knab, Revolut). Lukt de herkenning niet, dan volgt een duidelijke fout met het advies om
 * CAMT.053 te gebruiken — dat formaat is gestandaardiseerd én bevat begin- en
 * eindsaldo, waarmee de saldo-aansluiting kan controleren of het bestand compleet is.
 */
export function parseCsv(raw: string, fileName: string): ParsedBankStatement {
  // Een export zonder kopregel (ABN AMRO-TXT, ASN/SNS/RegioBank, Triodos) heeft
  // geen kolomnamen om op te zoeken: die leest headerless.ts, of weigert hem
  // met uitleg. Met een kopregel komt hier null terug en gaat het gewoon verder.
  const headerless = parseHeaderlessBankFile(raw, fileName);
  if (headerless) return headerless;

  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 2) throw new Error('Het CSV-bestand bevat geen transacties.');

  // De kopregel is niet altijd de eerste: Knab zet er "KNAB EXPORT;;;…" boven.
  // Eerder werd zo'n bestand geweigerd ("kon de datum- of bedragkolom niet
  // herkennen"). Neem de eerste van de eerste regels met een datum- én een
  // bedragkolom; vinden we die niet, dan blijft het de eerste regel.
  let headerIndex = 0;
  for (let i = 0; i < Math.min(lines.length - 1, 10); i += 1) {
    if (headerRoles(splitLine(lines[i], detectDelimiter(lines[i]))).ok) { headerIndex = i; break; }
  }
  const delim = detectDelimiter(lines[headerIndex]);
  const headers = splitLine(lines[headerIndex], delim);
  const rows = lines.slice(headerIndex + 1).map(l => splitLine(l, delim));
  const warnings: string[] = [];

  const { dateCol, debitPair, creditPair, hasPair, amountCol } = headerRoles(headers);
  const debitCol = hasPair ? debitPair : -1;
  const creditCol = hasPair ? creditPair : -1;

  /** Zien de waarden in deze kolom eruit zoals `test` wil (90% van de gevulde, hooguit 50 bekeken)? */
  const valuesLookLike = (col: number, test: (value: string) => boolean): boolean => {
    if (col < 0) return false;
    let seen = 0;
    let ok = 0;
    for (const cols of rows) {
      if (seen >= 50) break;
      const value = (cols[col] ?? '').trim();
      if (!value) continue;
      seen += 1;
      if (test(value)) ok += 1;
    }
    return seen > 0 && ok / seen >= 0.9;
  };

  const namedIndicatorCol = hasPair ? -1 : findCol(
    headers,
    ['af bij', 'bij af', 'debet credit', 'credit debet', 'debit credit', 'credit debit',
      'mutatiesoort indicator', 'debet of credit', 'indicator', 'dc', 'type'],
    [dateCol, amountCol],
  );
  // Een kolom telt pas als Af/Bij-kolom als de waarden er ook zo uitzien. Op
  // naam alleen pakte "Type betaling" (Knab) de plaats van "CreditDebet": dan
  // werden alle uitgaven ontvangsten, en bleef de waarschuwing daarover weg.
  const looksLikeIndicator = (col: number) => valuesLookLike(col, v => {
    const value = v.toLowerCase();
    return IND_DEBIT.test(value) || IND_CREDIT.test(value);
  });
  const indicatorCol = hasPair ? -1
    : looksLikeIndicator(namedIndicatorCol) ? namedIndicatorCol
    : headers.findIndex((_, col) => col !== dateCol && col !== amountCol && looksLikeIndicator(col));

  let claimed = [dateCol, amountCol, debitCol, creditCol, indicatorCol];
  // De eigen rekening (ING "Rekening", Rabobank "IBAN/BBAN", Knab
  // "Rekeningnummer", bunq "Account"). Eerder niet gelezen: een export met de
  // spaarrekening erbij ging helemaal de gekozen rekening in (check.ts).
  // Alleen exact en alleen als de waarden op een rekeningnummer lijken:
  // Revolut heeft een kolom "Account" met "Main EUR".
  const ownCandidate = findCol(headers,
    ['rekening', 'rekeningnummer', 'iban bban', 'account', 'eigen rekening', 'mijn rekening', 'rekening iban', 'account iban'],
    claimed, true);
  const ownAccountCol = valuesLookLike(ownCandidate, looksLikeOwnAccount) ? ownCandidate : -1;
  claimed = [...claimed, ownAccountCol];

  // Status (Revolut "State"): een post in behandeling of een teruggedraaide
  // betaling telde eerder mee als geboekt; de bank klopte dan stil niet.
  const stateCandidate = findCol(headers, ['state', 'status', 'transactiestatus'], claimed, true);
  const stateCol = valuesLookLike(stateCandidate, v => STATE_DONE.has(v.toLowerCase()) || STATE_NOT_DONE.has(v.toLowerCase())) ? stateCandidate : -1;
  claimed = [...claimed, stateCol];

  // Revolut Business: "Date completed (UTC)", "Total amount" met kosten,
  // "Reference" met het factuurnummer, "Payer" als naam. Herkend aan de status
  // en een kolom met "completed".
  const norm = headers.map(normHeader);
  const revolut = stateCol > -1 && norm.some(h => h.includes('completed'));
  const startedCol = revolut ? findCol(headers, ['date started', 'started date'], claimed) : -1;
  const dateIsUtc = revolut && dateCol > -1 && /\butc\b/.test(norm[dateCol]);
  const feeCol = revolut && amountCol > -1 && norm[amountCol] === 'amount' ? findCol(headers, ['fee'], claimed, true) : -1;
  const currencyCandidate = findCol(headers, ['payment currency', 'munt', 'valuta', 'valutacode', 'currency', 'ccy'], claimed, true);
  const currencyCol = valuesLookLike(currencyCandidate, v => /^[A-Z]{3}$/.test(v)) ? currencyCandidate : -1;
  claimed = [...claimed, startedCol, feeCol, currencyCol];

  let ibanCol = findCol(headers, ['tegenrekening iban', 'iban tegenpartij', 'counterparty iban', 'tegenrekeningnummer', 'tegenrekening', 'iban'], claimed);
  // bunq noemt de tegenrekening alleen "Counterparty"; eerder bleef het IBAN
  // leeg, en daarmee bankregels op IBAN en de dubbel-herkenning.
  if (ibanCol === -1) {
    const counterparty = findCol(headers, ['counterparty', 'tegenpartij iban'], claimed, true);
    if (valuesLookLike(counterparty, looksLikeIban)) ibanCol = counterparty;
  }
  // "Tegenrekeninghouder" (Knab) en "Payer" (Revolut) stonden niet bij de
  // namen; de naam bleef dan overal leeg.
  const nameCol = findCol(headers,
    ['naam tegenpartij', 'naam tegenrekening', 'tegenrekeninghouder', 'tegenpartij', 'naam', 'name', 'payer'],
    [...claimed, ibanCol]);
  const descCols = findAllCols(
    headers,
    ['mededeling', 'omschrijving', 'description', 'betalingskenmerk', 'memo', 'toelichting', 'reference'],
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
  const notDone = new Map<string, number>();
  for (const cols of rows) {
    const get = (idx: number): string => (idx > -1 && idx < cols.length ? cols[idx] : '');

    if (stateCol > -1) {
      const state = get(stateCol).trim();
      if (STATE_NOT_DONE.has(state.toLowerCase())) { notDone.set(state, (notDone.get(state) ?? 0) + 1); continue; }
    }

    const rawDate = get(dateCol) || get(startedCol);
    const bookingDate = dateIsUtc ? utcToAmsterdamDate(rawDate) : normalizeDate(rawDate);
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
      // Revolut zonder "Total amount": de kosten gaan er nog af.
      if (feeCol > -1) cents -= Math.abs(amountToCents(get(feeCol)));
    }
    if (cents === 0) { skipped += 1; continue; }

    const description = descCols.map(c => get(c)).filter(Boolean).join(' ').trim();
    const currency = get(currencyCol).trim().toUpperCase();
    // Revolut zet bij een pinbetaling de winkel alleen in "Description".
    const name = get(nameCol) || (revolut && descCols.length > 0 ? get(descCols[0]) : '');

    transactions.push({
      booking_date: bookingDate,
      value_date: null,
      amount_cents: cents,
      currency: /^[A-Z]{3}$/.test(currency) ? currency : 'EUR',
      counterparty_name: name || null,
      counterparty_iban: get(ibanCol).replace(/\s+/g, '') || null,
      description: description || null,
      structured_reference: null,
      end_to_end_id: null,
      bank_tx_id: null,
      account: get(ownAccountCol).trim() || null,
    });
  }

  if (transactions.length === 0) {
    throw new Error('Geen bruikbare transacties gevonden in dit CSV-bestand.');
  }
  if (notDone.size > 0) {
    const total = [...notDone.values()].reduce((s, n) => s + n, 0);
    const states = [...notDone.entries()].map(([state, n]) => `${n}× ${state}`).join(', ');
    warnings.push(`${total} regel(s) overgeslagen die de bank niet heeft uitgevoerd (${states}): in behandeling, teruggedraaid of geweigerd. Lees later opnieuw in; wat dan wel is uitgevoerd, komt mee.`);
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
