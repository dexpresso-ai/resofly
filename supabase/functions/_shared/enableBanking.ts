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

/** Kalenderdag in Nederland van een tijdstip; de bank geeft tijdstippen in UTC. */
export function amsterdamDate(value: unknown): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (ISO_DATE.test(text)) return text;
  const t = Date.parse(text);
  if (!Number.isFinite(t)) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(t));
}

/**
 * Wat er met een transactie gebeurt:
 *   booked   binnenhalen — geen status (sommige banken sturen hem niet mee) of BOOK
 *   pending  komt later geboekt binnen — PDNG, SCHD (ingepland), HOLD (gereserveerd)
 *   dropped  komt nooit — RJCT (geweigerd), CNCL (geannuleerd)
 *   unknown  OTHR of een nieuwe code: niet gokken, wel melden
 */
export type EbTransactionState = 'booked' | 'pending' | 'dropped' | 'unknown';

export function ebTransactionState(tx: any): EbTransactionState {
  const status = String(tx?.status ?? '').trim().toUpperCase();
  if (status === '' || status === 'BOOK') return 'booked';
  if (status === 'PDNG' || status === 'SCHD' || status === 'HOLD') return 'pending';
  if (status === 'RJCT' || status === 'CNCL') return 'dropped';
  return 'unknown';
}

export function isBookedEbTransaction(tx: any): boolean {
  return ebTransactionState(tx) === 'booked';
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

/**
 * Wat er van een opgehaalde batch binnenkomt, en waarom de rest niet. Geweigerde
 * en geannuleerde posten tellen nergens mee: daar ging geen geld over.
 */
export function prepareEbTransactions(raw: unknown): {
  transactions: MappedBankTransaction[]; pending: number; unknownStatus: number; unusable: number;
} {
  const list = Array.isArray(raw) ? raw : [];
  const transactions: MappedBankTransaction[] = [];
  let pending = 0;
  let unknownStatus = 0;
  let unusable = 0;
  for (const tx of list) {
    const state = ebTransactionState(tx);
    if (state === 'pending') { pending += 1; continue; }
    if (state === 'unknown') { unknownStatus += 1; continue; }
    if (state === 'dropped') continue;
    const mapped = mapEbTransaction(tx);
    if (mapped) transactions.push(mapped); else unusable += 1;
  }
  return { transactions, pending, unknownStatus, unusable };
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
 *   ITBD         geboekt saldo nu; zonder datum: de dag (in Nederland) van de
 *                laatste wijziging, anders vandaag
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
      candidates.push({ amount_cents: amount, date: reference ?? amsterdamDate(b?.last_change_date_time) ?? today, type, rank: 1 });
    } else if (type === 'OPBD' && reference) {
      candidates.push({ amount_cents: amount, date: dayBefore(reference), type, rank: 2 });
    }
  }
  // Het meest recente saldo eerst; bij dezelfde dag het eindsaldo vóór het tussensaldo.
  candidates.sort((a, b) => (a.date === b.date ? a.rank - b.rank : a.date < b.date ? 1 : -1));
  const best = candidates[0];
  return best ? { amount_cents: best.amount_cents, date: best.date, type: best.type } : null;
}

// ── De koppeling laten lopen: PSU-headers, toestemmingsduur, fouten, pagina's ──

/**
 * Met deze headers weet de bank dat de gebruiker er zelf bij is. Een opvraging
 * telt dan niet mee voor de PSD2-grens van vier keer per 24 uur op de
 * achtergrond (EBA Q&A 2018_4172). Alleen met een publiek IP: een intern adres
 * zegt de bank niets en sommige banken weigeren het.
 */
export type PsuHeaders = { 'Psu-Ip-Address'?: string; 'Psu-User-Agent'?: string };

function ipv4Parts(ip: string): number[] | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/** Een adres dat op internet bestaat: geen privé-, loopback-, link-local- of CGNAT-reeks. */
export function isPublicIp(ip: string): boolean {
  const v4 = ipv4Parts(ip);
  if (v4) {
    const [a, b] = v4;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;   // CGNAT
    if (a === 169 && b === 254) return false;             // link-local
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false;               // 192.0.0.0/24 en 192.0.2.0/24
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  const v6 = ip.toLowerCase();
  if (!/^[0-9a-f:]+$/.test(v6) || !v6.includes(':')) return false;
  if (v6 === '::' || v6 === '::1') return false;
  if (/^f[cd]/.test(v6)) return false;                    // unique local fc00::/7
  if (/^fe[89ab]/.test(v6)) return false;                 // link-local fe80::/10
  if (v6.startsWith('ff')) return false;                  // multicast
  if (v6.startsWith('2001:db8')) return false;            // documentatie
  return true;
}

/** Het IP van de gebruiker uit x-forwarded-for (eerste adres), zonder poort of haken. */
export function clientIpFrom(forwardedFor: string | null | undefined): string | null {
  const first = String(forwardedFor ?? '').split(',')[0]?.trim() ?? '';
  if (!first) return null;
  const bracketed = first.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1];
  const v4WithPort = first.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  return v4WithPort ? v4WithPort[1] : first;
}

export function psuHeaders(forwardedFor: string | null | undefined, userAgent: string | null | undefined): PsuHeaders {
  const ip = clientIpFrom(forwardedFor);
  if (!ip || !isPublicIp(ip)) return {};
  const headers: PsuHeaders = { 'Psu-Ip-Address': ip };
  const ua = String(userAgent ?? '').trim();
  if (ua) headers['Psu-User-Agent'] = ua.slice(0, 512);
  return headers;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Weet de bank zijn maximum niet, dan dit: elke bank staat minstens 90 dagen toe. */
export const SAFE_CONSENT_DAYS = 90;

/**
 * Tot wanneer we toestemming vragen: wat we willen (standaard 180 dagen, de
 * PSD2-grens sinds juli 2023), maar nooit langer dan de bank toestaat
 * (`maximum_consent_validity`, in seconden). Een uur speling voor klokverschil:
 * vraagt het meer dan het maximum, dan weigert de bank de hele koppeling.
 */
export function consentValidUntil(nowMs: number, wantedDays: number, maxSeconds: number | null | undefined): Date {
  const wanted = Math.max(1, Math.floor(wantedDays)) * DAY_MS;
  const max = Number(maxSeconds);
  const cap = Number.isFinite(max) && max > 0 ? Math.max(DAY_MS, max * 1000 - 60 * 60 * 1000) : SAFE_CONSENT_DAYS * DAY_MS;
  return new Date(nowMs + Math.min(wanted, cap));
}

/**
 * Wat een fout van Enable Banking betekent voor wat de gebruiker moet doen:
 *   auth             401/403: de toestemming is weg, óf onze eigen sleutel klopt
 *                    niet — bank-sync zoekt uit welke van de twee (GET /application)
 *   reconsent        de sessie is verlopen, ingetrokken of gesloten: opnieuw koppelen
 *   rate_limited     429: de bank staat even geen ophalen toe; later vanzelf weer
 *   bank_unavailable 5xx of geen antwoord: tijdelijk, later opnieuw
 *   other            iets anders (bv. een fout in de aanvraag)
 */
export type EbErrorKind = 'auth' | 'reconsent' | 'rate_limited' | 'bank_unavailable' | 'other';

export function classifyEbError(status: number, body: unknown): EbErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (!status || status >= 500) return 'bank_unavailable';
  const b = (body && typeof body === 'object') ? body as Record<string, unknown> : {};
  const code = String(b.error ?? b.code ?? '').toUpperCase();
  const message = String(b.message ?? b.detail ?? (typeof body === 'string' ? body : '')).toLowerCase();
  if (/(EXPIRED|CLOSED|REVOKED|INVALID)_SESSION|SESSION_(EXPIRED|CLOSED|REVOKED|DOES_NOT_EXIST|NOT_FOUND)/.test(code)) return 'reconsent';
  if (/session/.test(message) && /(expired|closed|revoked|not found|does not exist|verlopen)/.test(message)) return 'reconsent';
  if (status === 404 && /account/.test(message)) return 'reconsent';
  return 'other';
}

/** Hoogstens zoveel pagina's per rekening per keer; de rest komt de volgende keer. */
export const MAX_TRANSACTION_PAGES = 100;

/**
 * Alle pagina's van /transactions ophalen, tot er geen continuation_key meer
 * komt. Komt dezelfde sleutel terug, dan is er niets meer (sommige banken doen
 * dat in plaats van hem weg te laten). Bij het plafond: `truncated`, en dan mag
 * de sync zijn startpunt NIET vooruitzetten — anders valt de rest buiten het
 * venster van de volgende keer en komt hij nooit meer binnen. Hetzelfde als de
 * tijd op is (`outOfTime`, vóór elke volgende pagina gevraagd).
 */
export async function fetchAllTransactionPages(
  fetchPage: (continuationKey: string | null) => Promise<{ transactions?: unknown; continuation_key?: unknown } | null | undefined>,
  maxPages: number = MAX_TRANSACTION_PAGES,
  outOfTime: () => boolean = () => false,
): Promise<{ transactions: unknown[]; pages: number; truncated: boolean }> {
  const transactions: unknown[] = [];
  let key: string | null = null;
  let pages = 0;
  for (;;) {
    const page = await fetchPage(key);
    pages += 1;
    if (Array.isArray(page?.transactions)) transactions.push(...page.transactions);
    const next = typeof page?.continuation_key === 'string' && page.continuation_key ? page.continuation_key : null;
    if (!next || next === key) return { transactions, pages, truncated: false };
    if (pages >= maxPages || outOfTime()) return { transactions, pages, truncated: true };
    key = next;
  }
}
