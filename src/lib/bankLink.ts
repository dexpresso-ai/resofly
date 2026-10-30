// ============================================================
// Directe bankkoppeling (PSD2, Enable Banking): de terugkeer van de bank en de
// staat van een toestemming, zoals de app die leest.
//
// Dezelfde regels als supabase/functions/_shared/bankSync.ts; bankSync.test.ts
// vergelijkt de twee, zodat de app en bank-sync hetzelfde verstaan onder
// "verlopen" en "afgebroken".
// ============================================================

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type BankReturn =
  | { kind: 'code'; code: string; state: string }
  | { kind: 'error'; state: string; error: string; description: string };

/**
 * Komt de gebruiker net terug van de bank? Gelukt is `?code=…&state=…`,
 * afgebroken of geweigerd is `?error=…&state=…`. De state is altijd onze eigen
 * UUID; zonder die is het iets anders (een inloglink van Supabase heeft ook
 * `?code=` of `?error=access_denied`), en dan doen we niets.
 */
export function readBankReturn(search: string): BankReturn | null {
  const params = new URLSearchParams(search);
  const state = params.get('state')?.trim() || '';
  if (!UUID_RE.test(state)) return null;
  const code = params.get('code')?.trim() || '';
  if (code) return { kind: 'code', code, state };
  const error = params.get('error')?.trim() || '';
  if (error) return { kind: 'error', state, error, description: params.get('error_description')?.trim() || '' };
  return null;
}

/** Heeft de klant de toestemming zelf afgebroken (in plaats van dat de bank hem weigerde)? */
export function isCancelledBankReturn(error: string): boolean {
  return ['access_denied', 'cancelled', 'canceled', 'user_cancelled'].includes(String(error || '').trim().toLowerCase());
}

/**
 * Verlopen, en anders over hoeveel dagen. Ook zonder mislukte sync: de
 * verloopdatum staat vast vanaf het koppelen.
 */
export function consentState(
  req: { status?: string | null; expires_at?: string | null } | null | undefined,
  nowMs: number,
): { expired: boolean; daysLeft: number | null } {
  if (!req) return { expired: false, daysLeft: null };
  const expiresAt = req.expires_at ? Date.parse(req.expires_at) : NaN;
  const known = Number.isFinite(expiresAt);
  if (req.status === 'expired' || (known && expiresAt <= nowMs)) return { expired: true, daysLeft: 0 };
  return { expired: false, daysLeft: known ? Math.ceil((expiresAt - nowMs) / DAY_MS) : null };
}

/**
 * Loopt deze koppeling via de testomgeving van Enable Banking? Dat zie je aan
 * de toestemmingslink (tilisy-sandbox.enablebanking.com): een sandbox-app kan
 * alleen testbanken met testgegevens koppelen, nooit een echte rekening.
 */
export function isSandboxLink(link: string | null | undefined): boolean {
  if (!link) return false;
  try {
    return /(^|[.-])sandbox([.-]|$)/i.test(new URL(link).hostname);
  } catch {
    return false;
  }
}
