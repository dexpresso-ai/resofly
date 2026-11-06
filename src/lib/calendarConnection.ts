import type { CalendarConnection } from '../types';

/**
 * De terugkeer van Google of Microsoft na een agendakoppeling, en wat de
 * gebruiker daarbij te lezen krijgt. Puur (geen supabase-client), zodat
 * calendarConnection.test.ts het onder node kan vastleggen.
 *
 * De edge function (calendar-integrations) zet in het terugkeeradres óf een
 * code en state (afronden), óf een vaste foutcode. Alleen die codes: de tekst
 * die de gebruiker leest, komt hier vandaan en nooit uit het adres. Anders kan
 * iedereen een link naar de app maken met een eigen "foutmelding" erin.
 */

/** Gelijk aan CALENDAR_OAUTH_ERROR_CODES in supabase/functions/_shared/calendarOAuth.ts (de test bewaakt dat). */
export const CALENDAR_OAUTH_ERROR_CODES = ['geweigerd', 'beheerder', 'verlopen', 'ongeldig', 'storing', 'mislukt'] as const;
export type CalendarOAuthErrorCode = typeof CALENDAR_OAUTH_ERROR_CODES[number];
export type OAuthProvider = 'google' | 'microsoft';

export type CalendarOAuthReturn =
  | { kind: 'code'; code: string; state: string }
  | { kind: 'error'; error: CalendarOAuthErrorCode; provider: OAuthProvider | null };

const RETURN_PARAMS = ['calendar_code', 'calendar_state', 'calendar_error', 'calendar_provider'];

/**
 * Leest de terugkeer uit een adres. `cleaned` is hetzelfde adres zonder de
 * koppelparameters (voor history.replaceState), of null als er niets te lezen was.
 * Eerst las de app alleen code en state: wie bij Google op "Annuleren" klikte
 * of geen toestemming van zijn beheerder had, kwam terug zonder enige melding,
 * met ?calendar_error=… voorgoed in de adresbalk.
 */
export function parseCalendarOAuthReturn(href: string): { result: CalendarOAuthReturn | null; cleaned: string | null } {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { result: null, cleaned: null };
  }
  if (!RETURN_PARAMS.some(key => url.searchParams.has(key))) return { result: null, cleaned: null };

  const code = url.searchParams.get('calendar_code');
  const state = url.searchParams.get('calendar_state');
  const error = url.searchParams.get('calendar_error');
  const provider = url.searchParams.get('calendar_provider');
  for (const key of RETURN_PARAMS) url.searchParams.delete(key);
  const cleaned = `${url.pathname}${url.search}${url.hash}`;

  let result: CalendarOAuthReturn | null = null;
  if (error !== null) {
    const known = (CALENDAR_OAUTH_ERROR_CODES as readonly string[]).includes(error) ? error as CalendarOAuthErrorCode : 'mislukt';
    result = { kind: 'error', error: known, provider: provider === 'google' || provider === 'microsoft' ? provider : null };
  } else if (code && state && code.length <= 4096 && state.length <= 4096) {
    result = { kind: 'code', code, state };
  }
  return { result, cleaned };
}

function providerName(provider: OAuthProvider | string | null | undefined): string {
  return provider === 'google' ? 'Google' : provider === 'microsoft' ? 'Microsoft' : 'Google of Microsoft';
}

/** Wat de gebruiker leest bij een foutcode uit de terugkeer. */
export function calendarOAuthErrorText(error: CalendarOAuthErrorCode, provider: OAuthProvider | null): string {
  const name = providerName(provider);
  switch (error) {
    case 'geweigerd':
      return `Je hebt ${name} geen toestemming gegeven, dus er is niets gekoppeld. Wil je het toch? Klik dan opnieuw op koppelen.`;
    case 'beheerder':
      return `Je organisatie laat deze koppeling alleen toe met toestemming van een beheerder. Vraag de beheerder van je ${name}-account om ResoFly toe te staan, en koppel daarna opnieuw.`;
    case 'verlopen':
      return 'Het koppelen duurde te lang. Begin opnieuw met koppelen; het duurt meestal maar een minuut.';
    case 'ongeldig':
      return 'Deze koppellink klopt niet (meer). Begin opnieuw met koppelen vanuit Instellingen → Agenda.';
    case 'storing':
      return `${name} had even een storing. Probeer het over een paar minuten opnieuw.`;
    default:
      return `Het koppelen met ${name} lukte niet. Probeer het opnieuw; blijft het misgaan, laat het ons dan weten.`;
  }
}

export type ConnectionStatusView = {
  label: string;
  tone: 'ok' | 'warn' | 'danger';
  /** Alleen opnieuw koppelen helpt (of ligt het meest voor de hand). */
  needsReconnect: boolean;
  /** Uitleg onder de kaart; null als er niets te melden is. */
  hint: string | null;
};

/**
 * Hoe de status van een koppeling in beeld komt. Eerst stond hier het ruwe
 * Engelse woord ("error", "expired") zonder uitleg of knop. Op staging stond
 * zo de enige Google-koppeling wekenlang op "error", met als enige uitleg
 * "Bad Request" in de database.
 */
export function connectionStatusView(connection: Pick<CalendarConnection, 'status' | 'last_error' | 'provider'>): ConnectionStatusView {
  const name = providerName(connection.provider);
  switch (connection.status) {
    case 'active':
      return { label: 'Actief', tone: 'ok', needsReconnect: false, hint: null };
    case 'expired':
      return {
        label: 'Verlopen',
        tone: 'warn',
        needsReconnect: true,
        hint: connection.last_error || `${name} geeft ResoFly geen toegang meer. Koppel het account opnieuw; je instellingen blijven staan.`,
      };
    case 'revoked':
      return {
        label: 'Ingetrokken',
        tone: 'danger',
        needsReconnect: true,
        hint: connection.last_error || 'Deze koppeling is ingetrokken. Koppel het account opnieuw om je agenda weer te zien.',
      };
    default:
      return {
        label: 'Fout',
        tone: 'danger',
        needsReconnect: true,
        hint: connection.last_error || `Het ophalen bij ${name} lukte de laatste keer niet. Lukt het straks weer niet, koppel dan opnieuw.`,
      };
  }
}
