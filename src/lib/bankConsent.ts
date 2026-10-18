import type { BankRequisition } from '../types';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Zo lang van tevoren waarschuwt de rekeningkaart (en zet de beslislijst een kaart klaar). */
export const CONSENT_WARN_DAYS = 14;

export type ConsentState =
  | { kind: 'none' }
  | { kind: 'ok' | 'soon' | 'expired'; until: string | null; daysLeft: number | null };

/**
 * Hoe het met de toestemming van een gekoppelde rekening staat. Verlopen telt ook
 * als de status nog 'linked' is maar de datum voorbij: de geplande sync zet de
 * status pas bij zijn volgende ronde om, en tot dan komt er al niets meer binnen.
 */
const AMSTERDAM_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' });
/** Middernacht (UTC) van de kalenderdag in Nederland waarop dit tijdstip valt. */
function amsterdamDay(ms: number): number {
  return Date.parse(`${AMSTERDAM_DAY.format(new Date(ms))}T00:00:00Z`);
}

export function consentState(
  req: Pick<BankRequisition, 'status' | 'expires_at'> | undefined,
  now: number = Date.now(),
): ConsentState {
  if (!req) return { kind: 'none' };
  const until = req.expires_at ?? null;
  const t = until ? Date.parse(until) : NaN;
  // Kalenderdagen in Nederland: loopt hij vandaag om 18:00 af, dan is het
  // "vandaag" (0), morgen om 11:00 is "morgen" (1).
  const daysLeft = Number.isFinite(t) ? Math.round((amsterdamDay(t) - amsterdamDay(now)) / DAY_MS) : null;
  if (req.status === 'expired' || (Number.isFinite(t) && t <= now)) return { kind: 'expired', until, daysLeft };
  if (daysLeft !== null && daysLeft <= CONSENT_WARN_DAYS) return { kind: 'soon', until, daysLeft };
  return { kind: 'ok', until, daysLeft };
}
