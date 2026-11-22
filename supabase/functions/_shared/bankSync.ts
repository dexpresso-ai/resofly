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

const compactIban = (value: unknown) => String(value ?? '').replace(/\s+/g, '').toUpperCase();

/**
 * Enable Banking-transactie → regel voor import_bank_transactions.
 *
 * `ownIban` is het IBAN van de rekening zelf. Bij een bijschrijving is de
 * debtor de tegenpartij, bij een afschrijving de creditor. Een storno van een
 * incasso draait dat om: daarin is de debtor de zzp'er zelf. In het CAMT-
 * afschrift stond er dan "je eigen naam en IBAN" als tegenpartij, wat op een
 * privéstorting leek terwijl KPN kosten met btw terugboekte. Wijst de gekozen
 * kant naar de eigen rekening (of meldt de bank een storno), dan nemen we de
 * andere kant.
 */
export function mapEbTransaction(tx: any, ownIban?: string | null) {
  const magnitude = Math.abs(Math.round((parseFloat(tx?.transaction_amount?.amount ?? '0') || 0) * 100));
  const indicator = String(tx?.credit_debit_indicator || '').toUpperCase();
  const cents = indicator === 'DBIT' ? -magnitude : magnitude;
  const id = tx?.entry_reference || tx?.transaction_id || null;
  const bookingDate = (tx?.booking_date || tx?.value_date || '').slice(0, 10) || null;
  const valueDate = (tx?.value_date || '').slice(0, 10) || null;
  const reversal = tx?.reversal_indicator === true || String(tx?.reversal_indicator ?? '').toLowerCase() === 'true';
  const side = (debtor: boolean) => ({
    name: (debtor ? tx?.debtor?.name : tx?.creditor?.name) || null,
    iban: (debtor ? tx?.debtor_account?.iban : tx?.creditor_account?.iban) || null,
  });
  const debtorSide = reversal ? cents < 0 : cents > 0;
  let party = side(debtorSide);
  const own = compactIban(ownIban);
  if (own && compactIban(party.iban) === own) {
    const other = side(!debtorSide);
    if (other.name || other.iban) party = other;
  }
  const counterpartyName = party.name;
  const counterpartyIban = party.iban;
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
 * Moet de klant opnieuw toestemming geven? Bij een 401 van Enable Banking, of
 * een foutcode over een verlopen, gesloten of ingetrokken sessie.
 *
 * Een 403 telde eerder ook als verlopen toestemming. Maar de bank geeft 403
 * ook voor één rekening die ze niet (meer) vrijgeeft (Berlin Group:
 * RESOURCE_UNKNOWN). Eén spaarrekening zette zo de hele koppeling op
 * "verlopen": de betaalrekening kreeg "koppel de bank opnieuw", en de
 * nachtelijke sync sloeg beide rekeningen over. Een 403 of 404 zonder
 * sessiecode is nu een fout van die ene rekening (accountErrorText).
 */
export function needsReconsent(httpStatus: number | undefined, code: string | null): boolean {
  if (httpStatus === 401) return true;
  if (!code || /ACCOUNT/.test(code)) return false;
  return /(EXPIRED|CLOSED|REVOKED)/.test(code);
}

/**
 * De fouttekst bij één rekening. Bij een 403 of 404 zegt de bank dat ze deze
 * rekening niet (meer) vrijgeeft: opgeheven, of bij het koppelen niet
 * aangevinkt. Dan helpt "probeer later opnieuw" niet.
 */
export function accountErrorText(httpStatus: number | undefined, detail: string): string {
  if (httpStatus === 403 || httpStatus === 404) {
    return `De bank geeft deze rekening niet (meer) vrij (${detail}). Is de rekening opgeheven, zet hem dan op inactief. Wil je hem blijven volgen, koppel de bank dan opnieuw en kies deze rekening.`;
  }
  return detail;
}

/** Een periode die de koppeling niet kon ophalen (ISO-datums, beide dagen erbij). */
export interface SyncGap { from: string; to: string }

/**
 * Welk deel van de gevraagde periode de bank niet meer leverde.
 *
 * Na een lange onderbreking (verlopen toestemming, maanden later opnieuw
 * koppelen) vraagt de sync vanaf de vorige sync. Veel banken geven na een
 * nieuwe toestemming maar zo'n 90 dagen terug en antwoorden dan
 * WRONG_TRANSACTIONS_PERIOD; de sync vraagt opnieuw met "longest". Wat er
 * tussen de gevraagde datum en de eerste ontvangen mutatie zat, viel eerder
 * stil weg: de sync telde als geslaagd, zonder melding.
 *
 * Alleen na "longest", alleen voor een rekening die al eens gesynct was (wat
 * vóór de eerste sync ligt, is geen gat maar de tijd van vóór de koppeling),
 * en alleen als de eerste ontvangen mutatie ná de vorige sync ligt: binnen de
 * week overlap is er niets gemist. Het gat begint bij de gevraagde datum (de
 * overlap telt mee: een bank boekt soms met terugwerkende kracht). Kwam er
 * niets, dan loopt het tot vandaag: wat de bank wel had kunnen leveren, weten
 * we dan niet.
 */
export function syncGap(
  dateFrom: string, lastSyncedAt: string | null | undefined, usedLongest: boolean,
  receivedDates: Array<string | null | undefined>, todayIso: string,
): SyncGap | null {
  const last = lastSyncedAt ? String(lastSyncedAt).slice(0, 10) : '';
  if (!usedLongest || !/^\d{4}-\d{2}-\d{2}$/.test(last)) return null;
  const earliest = receivedDates.filter((d): d is string => !!d).map((d) => d.slice(0, 10)).sort()[0] ?? null;
  if (earliest && earliest <= last) return null;
  const to = earliest ? new Date(Date.parse(`${earliest}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10) : todayIso;
  return to >= dateFrom ? { from: dateFrom, to } : null;
}

const dateNl = (iso: string) => `${Number(iso.slice(8, 10))}-${Number(iso.slice(5, 7))}-${iso.slice(0, 4)}`;

/** De melding bij een gat, voor het resultaat van "Koppelen" en "Synchroniseren". */
export function describeSyncGap(gap: SyncGap): string {
  return `Van ${dateNl(gap.from)} t/m ${dateNl(gap.to)} gaf de bank via de koppeling geen transacties meer: de bank geeft na een nieuwe toestemming maar een beperkte periode terug. Lees met "Afschrift inlezen" een afschrift over die periode in, dan ontbreekt er niets.`;
}
