import { amsterdamTodayIso } from './dates.ts';

/**
 * Regels over offertes en facturen die het scherm moet kennen om geen knop of
 * formulier te tonen dat de server toch weigert. De server beslist; dit is de
 * spiegel ervan. Puur, zonder React of netwerk, zodat financeControl.test.ts
 * ze kan nalopen.
 */

/** Wat de klant met een offerte kan. */
export type QuoteDecision =
  /** Verstuurd en nog geldig: akkoord geven of weigeren kan. */
  | 'open'
  | 'accepted'
  | 'rejected'
  /** De afzender heeft hem ingetrokken (status 'cancelled'). */
  | 'withdrawn'
  /** Status 'expired', of verstuurd maar "geldig tot" is voorbij. */
  | 'expired'
  /** Nog niet verstuurd, of een status die de klant niet hoort te zien. */
  | 'unavailable';

/**
 * Kan de klant nog beslissen over deze offerte?
 *
 * Een verstuurde offerte springt niet vanzelf op 'expired' als "geldig tot"
 * voorbij is; daarom kijken we ook naar de datum, als kalenderdag in Nederland.
 * Eerder toonden de publieke pagina en het portaal bij een ingetrokken of
 * verlopen offerte gewoon de knoppen; de server weigerde het akkoord daarna,
 * maar de klant had dan al een formulier ingevuld dat niets kon.
 */
export function quoteDecision(
  quote: { status: string; valid_until: string | null | undefined },
  today: string = amsterdamTodayIso(),
): QuoteDecision {
  switch (quote.status) {
    case 'accepted': return 'accepted';
    case 'rejected': return 'rejected';
    case 'cancelled': return 'withdrawn';
    case 'expired': return 'expired';
    case 'sent': return isBeforeDay(quote.valid_until, today) ? 'expired' : 'open';
    default: return 'unavailable';
  }
}

/** Ligt deze datum (JJJJ-MM-DD, eventueel met tijd erachter) vóór `today`? Geen of een onleesbare datum: nee. */
function isBeforeDay(value: string | null | undefined, today: string): boolean {
  const day = String(value ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  return day < today;
}

/**
 * Houdt deze betaling crediteren tegen? Ja bij een betaling die loopt of rond
 * is ('pending', 'authorized', 'paid'), en bij een betaallink die nog te
 * gebruiken is: 'creating' of 'open' zonder vervaltijd, of met een vervaltijd
 * die nog moet komen. De server hanteert precies deze regel.
 *
 * Eerder hield elke 'creating' of 'open' het tegen, ook een checkout die allang
 * verlopen was. Een herinnering zonder gekoppelde Mollie liet zo een rij op
 * 'creating' staan, en daarna was de factuur nooit meer te crediteren.
 */
export function paymentBlocksCredit(
  payment: { status: string; checkout_expires_at: string | null | undefined },
  now: number = Date.now(),
): boolean {
  if (payment.status === 'pending' || payment.status === 'authorized' || payment.status === 'paid') return true;
  if (payment.status !== 'creating' && payment.status !== 'open') return false;
  if (!payment.checkout_expires_at) return true;
  const expiresAt = Date.parse(payment.checkout_expires_at);
  // Een vervaltijd die niet te lezen is, behandelen we als geen vervaltijd: de
  // link kan dan nog werken, en een dubbele betaling is erger dan een knop te weinig.
  return !Number.isFinite(expiresAt) || expiresAt > now;
}

/**
 * Houdt een van deze betalingen crediteren tegen? Alle betalingen van de
 * factuur, niet alleen de nieuwste: een oudere link die nog loopt, kan de klant
 * nog gebruiken terwijl er intussen een nieuwere is gemaakt.
 */
export function paymentsBlockCredit(
  payments: ReadonlyArray<{ status: string; checkout_expires_at: string | null | undefined }>,
  now: number = Date.now(),
): boolean {
  return payments.some(payment => paymentBlocksCredit(payment, now));
}

/**
 * Ligt de inhoud van deze factuur vast (regels, klant, datums, nummer)? Spiegel
 * van enforce_invoice_immutability in de database (20261106130000).
 *
 * Verstuurd, betaald of afgesloten: ja. Een betaling die loopt of rond is: ja.
 * Een concept waarvan alleen een ongebruikte betaallink bestaat, blijft
 * bewerkbaar: dat gebeurt als versturen mét betaallink mislukte (de link komt
 * vóór de mail). Eerder zat zo'n concept voorgoed op slot; nu vervalt de oude
 * link bij een wijziging, en komt er bij versturen een nieuwe voor het nieuwe bedrag.
 */
export function invoiceContentLocked(
  invoice: { status: string; locked_at?: string | null; locked_reason?: string | null },
  payments: ReadonlyArray<{ status: string }>,
): boolean {
  const committed = payments.some(payment => ['pending', 'authorized', 'paid', 'refunded', 'charged_back'].includes(payment.status));
  if (invoice.status === 'draft' && !committed && (!invoice.locked_at || invoice.locked_reason === 'payment_checkout_created')) return false;
  return Boolean(invoice.locked_at)
    || ['sent', 'overdue', 'paid', 'cancelled', 'void', 'written_off', 'refunded'].includes(invoice.status)
    || committed
    || payments.some(payment => payment.status === 'creating' || payment.status === 'open');
}
