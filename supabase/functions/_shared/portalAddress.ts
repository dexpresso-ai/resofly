// Het eigen inlogadres van het klantportaal per organisatie: /portal/<sleutel>.
//
// Waarom: het portaal had één adres voor iedereen (/portal). Welke leverancier
// bij een bezoeker hoort, bleek pas na het inloggen, dus een klant die voor het
// eerst kwam zag de standaardstijl van ResoFly met "Klantportaal" als naam. Met
// de sleutel in het adres weet het inlogscherm meteen wiens huisstijl het toont
// (portal-login, actie getBranding), zonder dat het van een e-mailadres iets
// verklapt. Elke mail met een link naar het portaal gebruikt daarom dit adres.
//
// De sleutel is de merknaam plus tien willekeurige tekens (migratie
// 20261105110000). Alleen de server maakt hem aan.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

/** Dezelfde eis als de CHECK op portal_login_addresses.key. */
const PORTAL_LOGIN_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-z2-7]{10}$/;

export function isPortalLoginKey(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 48 && PORTAL_LOGIN_KEY.test(value);
}

/**
 * De link naar het portaal. Met een geldige sleutel het eigen adres van de
 * organisatie, anders het algemene: een ontbrekend adres mag een mail nooit
 * tegenhouden, dan is het inlogscherm alleen even neutraal.
 */
export function portalLoginUrl(baseUrl: string, key: string | null | undefined, params?: Record<string, string>): string {
  const base = baseUrl.replace(/\/+$/, '');
  const path = isPortalLoginKey(key) ? `/portal/${key}` : '/portal';
  const query = params
    ? Object.entries(params).map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&')
    : '';
  return `${base}${path}${query ? `?${query}` : ''}`;
}

/**
 * Het inlogadres van één organisatie, gefilterd op `organizationId` (de
 * service-role ziet alles). Bestaat het nog niet, dan maakt
 * ensure_portal_login_key het aan. Gooit nooit: zonder adres (bijvoorbeeld
 * terwijl de migratie nog moet) gaat de mail met het algemene adres.
 */
export async function loadPortalLoginKey(supabaseAdmin: SupabaseClient, organizationId: string): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin.rpc('ensure_portal_login_key', { p_organization_id: organizationId });
    if (error) {
      console.warn('inlogadres van het portaal niet gevonden; de mail krijgt het algemene adres', error.message);
      return null;
    }
    return isPortalLoginKey(data) ? data : null;
  } catch (error) {
    console.warn('inlogadres van het portaal crashte; de mail krijgt het algemene adres', error instanceof Error ? error.message : error);
    return null;
  }
}
