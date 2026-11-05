/**
 * Hoe lang de publieke link van een offerte of contract werkt.
 *
 * Waarom dit bestaat: de link verliep altijd na een vast aantal dagen (30),
 * ook als de offerte of het contract langer geldig was. De mail zei "geldig
 * tot 31 januari", maar vanaf dag 31 gaf de link "verlopen" en kon de klant
 * niet meer akkoord geven of tekenen. Een verstuurde offerte kan bovendien
 * niet opnieuw worden verstuurd, dus dan restte alleen een nieuwe offerte.
 *
 * Nu: minstens de vaste termijn, en minstens tot en met de geldigheidsdatum
 * (plus een dag, zodat ook het einde van die dag in Nederland meetelt). Een
 * geldigheid van jaren laat de link niet jaren openstaan: hooguit een jaar.
 *
 * Puur: geen database, geen Deno. Getest in publicLinkExpiry.test.ts.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 366;

export function publicLinkExpiresAt(validUntil: string | null | undefined, ttlDays: number, now: number = Date.now()): string {
  const ttlEnd = now + Math.max(1, Number.isFinite(ttlDays) ? ttlDays : 1) * DAY_MS;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(validUntil ?? '').trim());
  if (!match) return new Date(ttlEnd).toISOString();
  const dayStart = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(dayStart)) return new Date(ttlEnd).toISOString();
  // Begin van de geldigheidsdag (UTC) + 2 dagen: dekt de hele dag in Nederland
  // (UTC+1/+2) en nog een dag waarin de klant "verlopen" te zien krijgt.
  const validEnd = Math.min(dayStart + 2 * DAY_MS, now + MAX_DAYS * DAY_MS);
  return new Date(Math.max(ttlEnd, validEnd)).toISOString();
}
