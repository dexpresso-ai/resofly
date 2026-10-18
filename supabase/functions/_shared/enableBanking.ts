// ============================================================
// Enable Banking → ResoFly: van wat de bank teruggeeft naar wat we boeken.
//
// Pure functies (geen I/O), zodat bank-sync ze gebruikt en de tests ze zonder
// Deno of netwerk kunnen draaien.
//
// · Alleen GEBOEKTE transacties komen binnen. Enable Banking levert ook
//   pending-transacties mee (status "PDNG"); die hebben vaak nog geen boekdatum
//   en later een andere omschrijving. Kwamen ze binnen, dan gaf de geboekte
//   versie op inhoud een tweede rij — twee keer boekbaar.
// · Het teken volgt de credit/debet-indicator. Ontbreekt die, dan het teken van
//   het bedrag zelf; voorheen werd elk bedrag zonder indicator een ontvangst.
// · Voor de saldo-aansluiting telt alleen een GEBOEKT saldo (closing/interim
//   booked). Een beschikbaar saldo telt de kredietlimiet mee, een verwacht saldo
//   de pending-posten: geen van beide sluit aan op geboekte transacties.
// ============================================================

/** Een transactie zoals de import-RPC (import_bank_transactions) hem verwacht. */
export interface MappedBankTransaction {
  booking_date: string;
  value_date: string | null;
  amount_cents: number;
  currency: string;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  description: string | null;
  structured_reference: null;
  end_to_end_id: null;
  bank_tx_id: string | null;
}

/** Een saldo dat aansluitbaar is op de geboekte transacties tot en met `date`. */
export interface BookedBalance {
  amount_cents: number;
  date: string;
  type: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** "123.45" / "-0.5" / 12 → centen; null als het geen getal is. */
export function decimalToCents(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function isoDate(value: unknown): string | null {
  const text = String(value ?? '').slice(0, 10);
  return ISO_DATE.test(text) ? text : null;
}

/** Alleen geboekt: zonder status (sommige banken sturen hem niet mee) of "BOOK". */
export function isBookedEbTransaction(tx: any): boolean {
  const status = String(tx?.status ?? '').trim().toUpperCase();
  return status === '' || status === 'BOOK';
}

/**
 * Eén Enable Banking-transactie → importregel. Null als hij niet te boeken is
 * (geen leesbare datum, geen bedrag of € 0,00). Een dedup-sleutel geven we
 * bewust niet mee: import_bank_transactions leidt die server-side uit de inhoud af.
 */
export function mapEbTransaction(tx: any): MappedBankTransaction | null {
  const raw = decimalToCents(tx?.transaction_amount?.amount);
  if (raw === null || raw === 0) return null;
  const indicator = String(tx?.credit_debit_indicator ?? '').trim().toUpperCase();
  const cents = indicator === 'DBIT' ? -Math.abs(raw) : indicator === 'CRDT' ? Math.abs(raw) : raw;

  const bookingDate = isoDate(tx?.booking_date) ?? isoDate(tx?.value_date) ?? isoDate(tx?.transaction_date);
  if (!bookingDate) return null;

  const incoming = cents > 0;
  const party = incoming ? tx?.debtor : tx?.creditor;
  const partyAccount = incoming ? tx?.debtor_account : tx?.creditor_account;
  const remittance = Array.isArray(tx?.remittance_information)
    ? tx.remittance_information.filter(Boolean).join(' ').trim()
    : String(tx?.remittance_information ?? '').trim();

  return {
    booking_date: bookingDate,
    value_date: isoDate(tx?.value_date),
    amount_cents: cents,
    currency: String(tx?.transaction_amount?.currency || 'EUR'),
    counterparty_name: party?.name || null,
    counterparty_iban: partyAccount?.iban || null,
    description: remittance || null,
    structured_reference: null,
    end_to_end_id: null,
    bank_tx_id: tx?.entry_reference || tx?.transaction_id || null,
  };
}

/** Wat er van een opgehaalde batch binnenkomt, en waarom de rest niet. */
export function prepareEbTransactions(raw: unknown): { transactions: MappedBankTransaction[]; pending: number; unusable: number } {
  const list = Array.isArray(raw) ? raw : [];
  const transactions: MappedBankTransaction[] = [];
  let pending = 0;
  let unusable = 0;
  for (const tx of list) {
    if (!isBookedEbTransaction(tx)) { pending += 1; continue; }
    const mapped = mapEbTransaction(tx);
    if (mapped) transactions.push(mapped); else unusable += 1;
  }
  return { transactions, pending, unusable };
}

function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Kies uit /accounts/{uid}/balances het saldo dat op de geboekte transacties
 * aansluit, met de dag waarop het geldt.
 *   CLBD / PRCD  geboekt eindsaldo op reference_date (zonder datum: onbruikbaar)
 *   ITBD         geboekt saldo nu; zonder datum: de laatste wijziging, anders vandaag
 *   OPBD         geboekt beginsaldo van reference_date = eindsaldo van de dag ervoor
 * Saldi in een andere valuta dan de rekening tellen niet.
 */
export function pickBookedBalance(raw: unknown, currency: string, today: string): BookedBalance | null {
  const list = Array.isArray(raw) ? raw : [];
  const wanted = String(currency || 'EUR').toUpperCase();
  const candidates: Array<BookedBalance & { rank: number }> = [];
  for (const b of list as any[]) {
    const type = String(b?.balance_type ?? '').trim().toUpperCase();
    const amount = decimalToCents(b?.balance_amount?.amount);
    const cur = String(b?.balance_amount?.currency || wanted).toUpperCase();
    if (amount === null || cur !== wanted) continue;
    const reference = isoDate(b?.reference_date);
    if (type === 'CLBD' || type === 'PRCD') {
      if (reference) candidates.push({ amount_cents: amount, date: reference, type, rank: 0 });
    } else if (type === 'ITBD') {
      candidates.push({ amount_cents: amount, date: reference ?? isoDate(b?.last_change_date_time) ?? today, type, rank: 1 });
    } else if (type === 'OPBD' && reference) {
      candidates.push({ amount_cents: amount, date: dayBefore(reference), type, rank: 2 });
    }
  }
  // Het meest recente saldo eerst; bij dezelfde dag het eindsaldo vóór het tussensaldo.
  candidates.sort((a, b) => (a.date === b.date ? a.rank - b.rank : a.date < b.date ? 1 : -1));
  const best = candidates[0];
  return best ? { amount_cents: best.amount_cents, date: best.date, type: best.type } : null;
}
