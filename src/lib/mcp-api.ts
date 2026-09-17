import { supabase } from './supabase';
import type { UUID } from '../types';

/**
 * De AI-koppelingen van deze gebruiker, vanuit de browser.
 *
 * Twee kanten:
 *  - KOPPELEN loopt via de autorisatieserver (`mcp-oauth`). Het toestemmings-
 *    scherm haalt daar op wie er toestemming vraagt en stuurt daar het akkoord
 *    naartoe. De browser maakt zelf nooit een koppeling aan.
 *  - BEHEREN (zien wat er openstaat, intrekken) gaat rechtstreeks via RLS: een
 *    gebruiker ziet alleen zijn eigen rijen in `mcp_grants` en mag daar alleen
 *    `revoked_at` op zetten. Daar is geen edge function voor nodig, en zo kan de
 *    intrek-knop niet stilvallen als die functie het even niet doet.
 */

const FUNCTIONS_BASE = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1`;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const OAUTH_FN = 'mcp-oauth';

/**
 * Het adres dat een klant in zijn AI-app plakt.
 *
 * Letterlijk dit, zonder slash erachter: Claude vergelijkt het met de `resource`
 * die de MCP-server in zijn discovery-document noemt, en één teken verschil is
 * daar een mislukte koppeling. Staat de connector achter een eigen domein
 * (MCP_RESOURCE_URL op de edge functions), zet VITE_MCP_SERVER_URL dan op
 * precies dezelfde waarde.
 */
export const MCP_SERVER_URL = String(
  import.meta.env.VITE_MCP_SERVER_URL
    || `${String(import.meta.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '')}/functions/v1/mcp`,
).replace(/\/+$/, '');

/**
 * Eén deur naar de autorisatieserver, omdat een verzoek dat niet AANKOMT hier
 * anders afloopt dan een verzoek dat wordt afgewezen.
 *
 * Komt het niet aan, dan geeft de browser `TypeError: Failed to fetch` — geen
 * status, geen body, en een Engelse zin die in een Nederlands scherm terechtkomt
 * zonder te zeggen wat de gebruiker eraan kan doen. Precies dat stond er op het
 * toestemmingsscherm van een klant. Het betekent altijd hetzelfde: het verzoek
 * is nooit bij ons geweest — geen verbinding, of de edge functions van deze
 * omgeving staan nog niet klaar (de frontend loopt daarop voor, zie
 * McpNotAvailableError verderop).
 */
async function fetchOauth(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${FUNCTIONS_BASE}/${OAUTH_FN}${path}`, init);
  } catch {
    throw new Error(
      'We konden de koppelserver niet bereiken. Controleer je internetverbinding — '
      + 'blijft het misgaan, dan staat de AI-koppeling in deze omgeving nog niet klaar.',
    );
  }
}

/** Wie er toestemming vraagt, zoals het toestemmingsscherm het toont. */
export interface McpConsentRequest {
  clientName: string;
  clientUri: string | null;
  logoUri: string | null;
  /** Wat deze client ten hoogste kan krijgen; de gebruiker kiest daarbinnen. */
  scope: string;
  /** Mag deze koppeling überhaupt wijzigingen klaarzetten? */
  mayPropose: boolean;
  expiresAt: string;
}

export interface McpGrant {
  id: UUID;
  organization_id: UUID;
  /** Wiens koppeling dit is. Een owner/admin ziet ook die van collega's. */
  user_id: UUID;
  client_id: string;
  label: string;
  scope: string;
  created_at: string;
  last_used_at: string | null;
}

/** Mag deze koppeling wijzigingen klaarzetten, of alleen meelezen? */
export function grantMayPropose(grant: McpGrant): boolean {
  return grant.scope.split(/[\s,]+/).includes('propose');
}

/** Staat er een koppelverzoek in de URL? Zo ja, dan is dit het ondertekende pakketje. */
export function readAuthorizeRequest(): string | null {
  const url = new URL(window.location.href);
  if (url.pathname !== '/mcp/authorize' && !url.pathname.startsWith('/mcp/authorize/')) return null;
  return url.searchParams.get('request');
}

export async function loadConsentRequest(request: string): Promise<McpConsentRequest> {
  // Bewust ZONDER apikey. Deze functie draait met verify_jwt = false (zie
  // supabase/config.toml) en wordt door AI-clients zonder enige Supabase-sleutel
  // aangeroepen, dus hij is hier niet nodig — en hij is niet gratis: `apikey` is
  // geen "simpele" header, dus de browser stuurt er eerst een OPTIONS overheen
  // en verstuurt dit verzoek alleen als dát antwoord de header toestaat. Eén
  // header die daar ontbreekt is een toestemmingsscherm dat "Failed to fetch"
  // toont. Zonder die header is dit een gewoon GET-verzoek dat meteen vertrekt.
  const res = await fetchOauth(`/consent?request=${encodeURIComponent(request)}`);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(payload?.error_description || payload?.error || 'Dit koppelverzoek is niet (meer) geldig.'));
  return {
    clientName: String(payload.client_name || 'Een AI-client'),
    clientUri: payload.client_uri ? String(payload.client_uri) : null,
    logoUri: payload.logo_uri ? String(payload.logo_uri) : null,
    scope: String(payload.scope || 'read'),
    mayPropose: Boolean(payload.may_propose),
    expiresAt: String(payload.expires_at || ''),
  };
}

/**
 * Akkoord of weigering. Geeft het adres terug waar de browser naartoe moet —
 * terug naar de AI-client, met een code of met een nette foutmelding.
 */
export async function decideConsent(
  request: string,
  decision: 'allow' | 'deny',
  organizationId: UUID,
  label: string,
  /** Wat de gebruiker toestaat: alleen meelezen, of ook klaarzetten. */
  scope: string,
): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Je sessie is verlopen. Log opnieuw in en probeer het nog eens.');

  // Hier kan de OPTIONS er niet af: met een Authorization-header is dit nooit
  // een "simpel" verzoek. Die kant staat goed — /approve antwoordt met de
  // gedeelde origin-controle uit edgeAuth.ts, die `apikey` wél toestaat.
  const res = await fetchOauth('/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: ANON_KEY },
    body: JSON.stringify({ request, decision, organizationId, label, scope }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(payload?.error || 'Het koppelen is niet gelukt. Probeer het opnieuw vanuit je AI-app.'));
  return String(payload.redirect || '');
}

/**
 * De frontend loopt via Cloudflare Pages vóór op de database: een push rolt de
 * app uit, maar de migratie en de edge functions gaan langs een andere weg. In
 * dat gaatje bestaat `mcp_grants` nog niet, en dan geeft PostgREST een fout waar
 * een gebruiker niets van begrijpt ("Could not find the table … in the schema
 * cache") — in het rood, in zijn instellingen, terwijl er niets mis is.
 *
 * Daarom onderscheiden we "er is iets stuk" van "dit staat hier nog niet aan".
 */
export class McpNotAvailableError extends Error {
  constructor() { super('De AI-koppeling is in deze omgeving nog niet ingeschakeld.'); this.name = 'McpNotAvailableError'; }
}

/** Herkent het antwoord van PostgREST op een tabel die (nog) niet bestaat. */
function isMissingTable(error: { code?: string; message?: string }): boolean {
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  const message = String(error.message ?? '').toLowerCase();
  return message.includes('schema cache') || message.includes('does not exist');
}

/**
 * Alle koppelingen die deze gebruiker MAG zien. Welke dat zijn, beslist RLS:
 * een gewoon teamlid krijgt zijn eigen rijen, een owner of admin die van de
 * hele organisatie. Het scherm splitst ze op `user_id`.
 */
export async function listGrants(organizationId: UUID): Promise<McpGrant[]> {
  const { data, error } = await supabase
    .from('mcp_grants')
    .select('id, organization_id, user_id, client_id, label, scope, created_at, last_used_at')
    .eq('organization_id', organizationId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false });
  if (error) {
    if (isMissingTable(error)) throw new McpNotAvailableError();
    throw new Error(`De AI-koppelingen konden niet worden opgehaald: ${error.message}`);
  }
  return (data ?? []) as McpGrant[];
}

/**
 * Intrekken. De database trekt de bijbehorende tokens mee in (trigger
 * `mcp_grants_revoke_tokens`), zodat de AI meteen de deur dicht vindt en niet
 * pas als zijn toegangstoken over een uur verloopt.
 */
export async function revokeGrant(grantId: UUID): Promise<void> {
  const { error } = await supabase
    .from('mcp_grants')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', grantId)
    .is('revoked_at', null);
  if (error) throw new Error(`Intrekken is niet gelukt: ${error.message}`);
}
