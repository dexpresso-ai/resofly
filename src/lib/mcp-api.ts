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

/** Wie er toestemming vraagt, zoals het toestemmingsscherm het toont. */
export interface McpConsentRequest {
  clientName: string;
  clientUri: string | null;
  logoUri: string | null;
  scope: string;
  expiresAt: string;
}

export interface McpGrant {
  id: UUID;
  organization_id: UUID;
  client_id: string;
  label: string;
  scope: string;
  created_at: string;
  last_used_at: string | null;
}

/** Staat er een koppelverzoek in de URL? Zo ja, dan is dit het ondertekende pakketje. */
export function readAuthorizeRequest(): string | null {
  const url = new URL(window.location.href);
  if (url.pathname !== '/mcp/authorize' && !url.pathname.startsWith('/mcp/authorize/')) return null;
  return url.searchParams.get('request');
}

export async function loadConsentRequest(request: string): Promise<McpConsentRequest> {
  const res = await fetch(`${FUNCTIONS_BASE}/${OAUTH_FN}/consent?request=${encodeURIComponent(request)}`, {
    headers: { apikey: ANON_KEY },
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(payload?.error_description || payload?.error || 'Dit koppelverzoek is niet (meer) geldig.'));
  return {
    clientName: String(payload.client_name || 'Een AI-client'),
    clientUri: payload.client_uri ? String(payload.client_uri) : null,
    logoUri: payload.logo_uri ? String(payload.logo_uri) : null,
    scope: String(payload.scope || 'read'),
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
): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Je sessie is verlopen. Log opnieuw in en probeer het nog eens.');

  const res = await fetch(`${FUNCTIONS_BASE}/${OAUTH_FN}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: ANON_KEY },
    body: JSON.stringify({ request, decision, organizationId, label }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(payload?.error || 'Het koppelen is niet gelukt. Probeer het opnieuw vanuit je AI-app.'));
  return String(payload.redirect || '');
}

export async function listGrants(organizationId: UUID): Promise<McpGrant[]> {
  const { data, error } = await supabase
    .from('mcp_grants')
    .select('id, organization_id, client_id, label, scope, created_at, last_used_at')
    .eq('organization_id', organizationId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`De AI-koppelingen konden niet worden opgehaald: ${error.message}`);
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
