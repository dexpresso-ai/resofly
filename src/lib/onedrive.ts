/**
 * De kopie van Inhoud in OneDrive, de kant van de app: de terugkeer na het
 * koppelen en de zinnen in Instellingen → OneDrive. Puur (geen
 * supabase-client), zodat onedrive.test.ts het onder node vastlegt.
 *
 * Plan: docs/plannen/ONEDRIVE_KOPIE_PLAN_2026-11-24.md.
 */

/** Gelijk aan ONEDRIVE_RETURN_PARAMS in supabase/functions/_shared/onedriveSync.ts (de test bewaakt dat). */
export const ONEDRIVE_RETURN_PARAMS = ['onedrive_code', 'onedrive_state', 'onedrive_error'] as const;

/** Dezelfde vaste foutcodes als bij de agenda: de callback gebruikt classifyProviderError. */
export const ONEDRIVE_OAUTH_ERROR_CODES = ['geweigerd', 'beheerder', 'verlopen', 'ongeldig', 'storing', 'mislukt'] as const;
export type OneDriveOAuthErrorCode = typeof ONEDRIVE_OAUTH_ERROR_CODES[number];

export type OneDriveOAuthReturn =
  | { kind: 'code'; code: string; state: string }
  | { kind: 'error'; error: OneDriveOAuthErrorCode };

/**
 * Leest de terugkeer uit een adres. `cleaned` is hetzelfde adres zonder de
 * koppelparameters, of null als er niets te lezen was. Wat de gebruiker leest,
 * komt hier vandaan en nooit uit het adres: anders kon iedereen een link naar
 * de app maken met een eigen "foutmelding" erin.
 */
export function parseOneDriveOAuthReturn(href: string): { result: OneDriveOAuthReturn | null; cleaned: string | null } {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { result: null, cleaned: null };
  }
  if (!ONEDRIVE_RETURN_PARAMS.some(key => url.searchParams.has(key))) return { result: null, cleaned: null };
  const code = url.searchParams.get('onedrive_code');
  const state = url.searchParams.get('onedrive_state');
  const error = url.searchParams.get('onedrive_error');
  for (const key of ONEDRIVE_RETURN_PARAMS) url.searchParams.delete(key);
  const cleaned = `${url.pathname}${url.search}${url.hash}`;
  let result: OneDriveOAuthReturn | null = null;
  if (error !== null) {
    result = { kind: 'error', error: (ONEDRIVE_OAUTH_ERROR_CODES as readonly string[]).includes(error) ? error as OneDriveOAuthErrorCode : 'mislukt' };
  } else if (code && state && code.length <= 4096 && state.length <= 4096) {
    result = { kind: 'code', code, state };
  }
  return { result, cleaned };
}

export function oneDriveOAuthErrorText(error: OneDriveOAuthErrorCode): string {
  switch (error) {
    case 'geweigerd':
      return 'Je hebt Microsoft geen toestemming gegeven, dus OneDrive is niet gekoppeld. Wil je het toch? Kies dan opnieuw "OneDrive koppelen".';
    case 'beheerder':
      return 'Je organisatie laat deze koppeling alleen toe met toestemming van een beheerder. Vraag de beheerder van je Microsoft-account om ResoFly toe te staan, en koppel daarna opnieuw.';
    case 'verlopen':
      return 'Het koppelen duurde te lang. Begin opnieuw; het duurt meestal maar een minuut.';
    case 'ongeldig':
      return 'Deze koppellink klopt niet (meer). Begin opnieuw vanuit Instellingen → OneDrive.';
    case 'storing':
      return 'Microsoft had even een storing. Probeer het over een paar minuten opnieuw.';
    default:
      return 'Het koppelen met OneDrive lukte niet. Probeer het opnieuw; blijft het misgaan, laat het ons dan weten.';
  }
}

export type OneDriveConnection = {
  account: string | null;
  name: string | null;
  status: 'active' | 'expired' | 'error';
  lastError: string | null;
  enabled: boolean;
  rootName: string | null;
  rootWebUrl: string | null;
  lastSyncedAt: string | null;
  enabledAt: string | null;
  connectedByMe: boolean;
};

export type OneDriveFailedItem = {
  id: string;
  itemType: string;
  kind: string;
  name: string;
  lastError: string | null;
  attempts: number;
  updatedAt: string;
};

export type OneDriveStatus = {
  configured: boolean;
  connection: OneDriveConnection | null;
  queue: { pending: number; failed: number; failedItems: OneDriveFailedItem[] };
};

/** Waar het gesprek in Instellingen → OneDrive staat. */
export type OneDriveStage = 'niet-ingericht' | 'niet-gekoppeld' | 'opnieuw-koppelen' | 'uit' | 'aan';

export function oneDriveStage(status: OneDriveStatus): OneDriveStage {
  if (!status.configured) return 'niet-ingericht';
  const c = status.connection;
  if (!c) return 'niet-gekoppeld';
  if (c.status !== 'active') return 'opnieuw-koppelen';
  return c.enabled ? 'aan' : 'uit';
}

function timeNL(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });
  const sameDay = d.toLocaleDateString('nl-NL', { timeZone: 'Europe/Amsterdam' }) === now.toLocaleDateString('nl-NL', { timeZone: 'Europe/Amsterdam' });
  return sameDay ? `vandaag om ${time}` : `${d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', timeZone: 'Europe/Amsterdam' })} om ${time}`;
}

/** Eén regel over hoe de kopie ervoor staat. */
export function syncSummary(status: OneDriveStatus, now = new Date()): { tone: 'ok' | 'busy' | 'warn'; text: string } {
  const c = status.connection;
  const { pending, failed } = status.queue;
  if (c?.lastError) return { tone: 'warn', text: c.lastError };
  if (failed > 0) return { tone: 'warn', text: `${failed === 1 ? 'Eén wijziging kwam' : `${failed} wijzigingen kwamen`} niet in OneDrive. Zie hieronder.` };
  if (pending > 0) return { tone: 'busy', text: `${pending === 1 ? 'Eén wijziging gaat' : `${pending} wijzigingen gaan`} nu naar OneDrive.` };
  if (c?.lastSyncedAt) return { tone: 'ok', text: `De kopie is bij. Laatst bijgewerkt ${timeNL(c.lastSyncedAt, now)}.` };
  return { tone: 'ok', text: 'De kopie is bij. Er is sinds het aanzetten nog niets veranderd.' };
}
