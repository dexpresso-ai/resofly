import { createClient } from '@supabase/supabase-js';
import { isSupabaseConfigured, type SupabaseAuthAdapter } from './supabase';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// Aparte Supabase-client voor het klantportaal (/portal). Twee redenen voor een
// eigen client met eigen storageKey:
//  1. Sessie-isolatie — een ingelogde klant en een ingelogde medewerker in
//     dezelfde browser overschrijven elkaars sessie niet.
//  2. Magische-link-detectie — alléén op /portal verwerkt deze client de
//     access-token-hash in de URL; de medewerkers-client laat die daar met opzet
//     staan (zie src/lib/supabase.ts). Zo verwerkt precies één client de link.
const onPortalRoute = typeof window !== 'undefined' && window.location.pathname.startsWith('/portal');

export const supabasePortal = createClient(
  isSupabaseConfigured ? url! : 'https://example.supabase.co',
  isSupabaseConfigured ? anon! : 'placeholder-anon-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: onPortalRoute,
      storageKey: 'resofly.portal.auth',
      // PKCE, net als de medewerkers-client (zie src/lib/supabase.ts): geen
      // tokens in de URL, en een link werkt alleen in de browser die hem aanvroeg.
      flowType: 'pkce',
    },
  },
);

// Zelfde adapter-cast als de medewerkers-client: supabase-js v2 houdt deze
// auth-methodes op runtime, maar sommige package-typings exposen ze via een
// smallere class. De cast houdt de aanroepen type-veilig.
export const supabasePortalAuth = supabasePortal.auth as unknown as SupabaseAuthAdapter;

/** De tokens van een verse inlog, nog niet opgeslagen. */
export interface PortalLoginTokens {
  access_token: string;
  refresh_token: string;
}

/**
 * Het token van de inloglink inwisselen bij Supabase Auth, zonder de inlog op
 * te slaan. Eerst ging dat met supabasePortal.auth.verifyOtp: dan stond de
 * inlog meteen in de browser, en vroeg het portaal al gegevens op terwijl hij
 * nog niet was vastgelegd (portal-login, bindSession). Dat weigert
 * client-portal sinds migratie 20261109020000. Nu legt de app hem eerst vast
 * en slaat hem dan op (setSession).
 *
 * Alleen het token dat portal-login na de link teruggeeft: een code van
 * Supabase staat sinds migratie 20261109150000 niet meer in de mail (die kon
 * een andere website de klant ontfutselen).
 *
 * Rechtstreeks vanuit de browser, niet via de server: de remmen van Supabase
 * Auth tellen per IP-adres, en via de server zouden alle klanten samen tellen.
 * Null als de link niet (meer) klopt.
 */
export async function verifyPortalLogin(params: { tokenHash: string }): Promise<PortalLoginTokens | null> {
  if (!isSupabaseConfigured) return null;
  const body = { type: 'magiclink', token_hash: params.tokenHash };
  try {
    const res = await fetch(`${url!.replace(/\/+$/, '')}/auth/v1/verify`, {
      method: 'POST',
      // Zoals supabase-js zelf: de publieke sleutel in beide headers.
      headers: { apikey: anon!, Authorization: `Bearer ${anon!}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null) as { access_token?: unknown; refresh_token?: unknown } | null;
    return typeof json?.access_token === 'string' && typeof json?.refresh_token === 'string'
      ? { access_token: json.access_token, refresh_token: json.refresh_token }
      : null;
  } catch {
    return null;
  }
}
