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
export function consentState(
  req: Pick<BankRequisition, 'status' | 'expires_at'> | undefined,
  now: number = Date.now(),
): ConsentState {
  if (!req) return { kind: 'none' };
  const until = req.expires_at ?? null;
  const t = until ? Date.parse(until) : NaN;
  const daysLeft = Number.isFinite(t) ? Math.ceil((t - now) / DAY_MS) : null;
  if (req.status === 'expired' || (Number.isFinite(t) && t <= now)) return { kind: 'expired', until, daysLeft };
  if (daysLeft !== null && daysLeft <= CONSENT_WARN_DAYS) return { kind: 'soon', until, daysLeft };
  return { kind: 'ok', until, daysLeft };
}
