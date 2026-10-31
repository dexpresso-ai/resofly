// ============================================================
// bank-sync (Enable Banking): de regels, zonder netwerk en zonder Deno.
//
// bank-sync/index.ts praat met Enable Banking en de database; wat er met de
// antwoorden gebeurt — welke transacties we overnemen, hoe lang een
// toestemming geldt, wanneer hij voorbij is, wat een terugkeer van de bank
// betekent — staat hier, zodat het los te testen is (bankSync.test.ts).
// src/lib/bankLink.ts heeft voor de app dezelfde regels over de terugkeer en
// het verlopen; de test bewaakt dat die twee niet uiteenlopen.
// ============================================================

export type PsuType = 'business' | 'personal';
export const PSU_TYPES: readonly PsuType[] = ['business', 'personal'];

const DAY_MS = 24 * 60 * 60 * 1000;
/** Zonder opgave van de bank houden we 90 dagen aan: dat staat PSD2 altijd toe. */
export const FALLBACK_CONSENT_DAYS = 90;
/**
 * Speling op het maximum van de bank: Enable Banking weigert een valid_until ná
 * zijn eigen "nu + maximum", en onze klok en de zijne lopen nooit precies gelijk.
 */
const CONSENT_MARGIN_MS = 60 * 60 * 1000;

/** Bank (ASPSP) voor de bankkiezer, uit GET /aspsps. */
export interface BankInstitutionInfo {
  id: string;
  name: string;
  bic: string | null;
  logo: string | null;
  /** Welke rekeningsoorten de koppeling bij deze bank aankan; leeg = onbekend. */
  psu_types: PsuType[];
}

/** Een ASPSP uit GET /aspsps, of null als hij geen naam heeft (de naam ís bij Enable Banking het id). */
export function mapAspsp(raw: any): BankInstitutionInfo | null {
  const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
  if (!name) return null;
  return { id: name, name, bic: raw?.bic ?? null, logo: raw?.logo ?? null, psu_types: psuTypesOf(raw?.psu_types) };
}

export function psuTypesOf(value: unknown): PsuType[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set(value.map((v) => String(v ?? '').trim().toLowerCase()));
  return PSU_TYPES.filter((t) => seen.has(t));
}

/**
 * De rekeningsoort voor POST /auth: wat de gebruiker koos (anders de
 * standaard), mits de bank hem aankan. null = deze bank kan het niet; de
 * bankkiezer toont zo'n bank dan ook niet.
 */
export function choosePsuType(requested: unknown, supported: PsuType[], fallback: PsuType): PsuType | null {
  const wanted: PsuType = requested === 'business' || requested === 'personal' ? requested : fallback;
  if (supported.length === 0 || supported.includes(wanted)) return wanted;
  return null;
}

/**
 * Tot wanneer de toestemming geldt (access.valid_until). Zonder eigen instelling
 * het maximum dat de bank toestaat (maximum_consent_validity, in seconden) — bij
 * de meeste banken 180 dagen, dus de klant hoeft half zo vaak opnieuw
 * toestemming te geven als met een vaste 90. Een ingestelde termijn
 * (ENABLEBANKING_CONSENT_DAYS) geldt als bovengrens; boven het maximum van de
 * bank gaan we nooit, want dan weigert Enable Banking de hele koppeling.
 */
export function consentValidUntil(nowMs: number, aspspMaxSeconds: unknown, configuredDays: number | null): string {
  const maxSeconds = Number(aspspMaxSeconds);
  const bankCapMs = Number.isFinite(maxSeconds) && maxSeconds > 0
    ? maxSeconds * 1000 - Math.min(CONSENT_MARGIN_MS, maxSeconds * 10)
    : null;
  const wantedMs = configuredDays && configuredDays > 0 ? configuredDays * DAY_MS : (bankCapMs ?? FALLBACK_CONSENT_DAYS * DAY_MS);
  return new Date(nowMs + (bankCapMs === null ? wantedMs : Math.min(wantedMs, bankCapMs))).toISOString();
}

/**
 * Alleen geboekte transacties. Een "pending" post (PDNG) verandert bij het
 * boeken nog van datum, bedrag of omschrijving; de ontdubbeling werkt op inhoud,
 * dus die zou daarna als tweede regel terugkomen. Zonder status (oudere
 * koppelingen) nemen we hem over: Enable Banking geeft dan alleen geboekte.
 */
export function isBookedTransaction(tx: any): boolean {
  const status = String(tx?.status ?? '').trim().toUpperCase();
  return status === '' || status === 'BOOK';
}

/** Enable Banking-transactie → regel voor import_bank_transactions. */
export function mapEbTransaction(tx: any) {
  const magnitude = Math.abs(Math.round((parseFloat(tx?.transaction_amount?.amount ?? '0') || 0) * 100));
  const indicator = String(tx?.credit_debit_indicator || '').toUpperCase();
  const cents = indicator === 'DBIT' ? -magnitude : magnitude;
  const id = tx?.entry_reference || tx?.transaction_id || null;
  const bookingDate = (tx?.booking_date || tx?.value_date || '').slice(0, 10) || null;
  const valueDate = (tx?.value_date || '').slice(0, 10) || null;
  const incoming = cents > 0;
  const counterpartyName = (incoming ? tx?.debtor?.name : tx?.creditor?.name) || null;
  const counterpartyIban = (incoming ? tx?.debtor_account?.iban : tx?.creditor_account?.iban) || null;
  const remittance = Array.isArray(tx?.remittance_information)
    ? tx.remittance_information.filter(Boolean).join(' ').trim()
    : (tx?.remittance_information || '');
  // Géén dedup_key: import_bank_transactions leidt die server-side af uit de
  // inhoud. Voorheen maakte deze functie `eb:`-sleutels terwijl de afschrift-import
  // `tx:`/`h:` gebruikte — dezelfde transactie via beide wegen gaf dus twee rijen.
  return {
    booking_date: bookingDate, value_date: valueDate, amount_cents: cents,
    currency: tx?.transaction_amount?.currency || 'EUR', counterparty_name: counterpartyName,
    counterparty_iban: counterpartyIban, description: remittance || null, structured_reference: null,
    end_to_end_id: null, bank_tx_id: id,
  };
}

/**
 * Vanaf welke boekdatum een sync ophaalt: een week overlap op de vorige sync
 * (banken boeken soms met terugwerkende kracht; de ontdubbeling vangt de
 * overlap op), of 90 dagen terug bij de eerste keer.
 */
export function syncDateFrom(lastSyncedAt: string | null | undefined, nowMs: number): string {
  const last = lastSyncedAt ? Date.parse(lastSyncedAt) : NaN;
  const since = Number.isFinite(last) ? last - 7 * DAY_MS : nowMs - FALLBACK_CONSENT_DAYS * DAY_MS;
  return new Date(since).toISOString().slice(0, 10);
}

/**
 * Is deze toestemming voorbij? Niet alleen na een mislukte sync: de
 * verloopdatum staat vast vanaf het koppelen, dus die telt ook als niemand op
 * Synchroniseer drukte.
 */
export function consentExpired(req: { status?: string | null; expires_at?: string | null } | null | undefined, nowMs: number): boolean {
  if (!req) return false;
  if (req.status === 'expired') return true;
  const expiresAt = req.expires_at ? Date.parse(req.expires_at) : NaN;
  return Number.isFinite(expiresAt) && expiresAt <= nowMs;
}

/**
 * De bank stuurt de klant terug met `?error=…` in plaats van `?code=…`: zelf
 * afgebroken (access_denied, of CANCELLED vanuit Enable Banking) of door de bank
 * geweigerd. `detail` is wat we bij de koppeling vastleggen.
 */
export function bankReturnError(error: string, description: string): { status: 'cancelled' | 'error'; detail: string } {
  const code = String(error || '').trim();
  const text = String(description || '').trim();
  const cancelled = ['access_denied', 'cancelled', 'canceled', 'user_cancelled'].includes(code.toLowerCase());
  return { status: cancelled ? 'cancelled' : 'error', detail: (text ? `${code}: ${text}` : code || 'onbekende fout').slice(0, 500) };
}

/** De foutcode uit een foutantwoord van Enable Banking (bv. WRONG_TRANSACTIONS_PERIOD), of null. */
export function ebErrorCode(payload: unknown): string | null {
  const p = payload as { error?: unknown; code?: unknown } | null;
  for (const value of [p?.error, p?.code]) {
    if (typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,}$/.test(value.trim())) return value.trim();
  }
  return null;
}

/**
 * Moet de klant opnieuw toestemming geven? Bij 401/403 van Enable Banking, of
 * een foutcode over een verlopen, gesloten of ingetrokken sessie.
 */
export function needsReconsent(httpStatus: number | undefined, code: string | null): boolean {
  if (httpStatus === 401 || httpStatus === 403) return true;
  return !!code && /(EXPIRED|CLOSED|REVOKED)/.test(code);
}
