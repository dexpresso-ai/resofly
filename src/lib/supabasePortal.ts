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
    },
  },
);

// Zelfde adapter-cast als de medewerkers-client: supabase-js v2 houdt deze
// auth-methodes op runtime, maar sommige package-typings exposen ze via een
// smallere class. De cast houdt de aanroepen type-veilig.
export const supabasePortalAuth = supabasePortal.auth as unknown as SupabaseAuthAdapter;
