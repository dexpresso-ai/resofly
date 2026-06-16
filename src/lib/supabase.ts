import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(url && anon && !url.includes('YOUR_PROJECT') && !anon.includes('YOUR_SUPABASE'));

if (!isSupabaseConfigured) {
  console.warn('Missing Supabase settings. Copy .env.example to .env.local and fill VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY.');
}

// Op /portal mag de medewerkers-client de magische-link-hash in de URL NIET
// opslokken: daar verwerkt de aparte portaal-client (src/lib/supabasePortal.ts,
// eigen storageKey) de klant-login. Buiten /portal blijft URL-detectie aan voor
// de normale medewerkers-magic-link.
const onPortalRoute = typeof window !== 'undefined' && window.location.pathname.startsWith('/portal');

export const supabase = createClient(
  isSupabaseConfigured ? url! : 'https://example.supabase.co',
  isSupabaseConfigured ? anon! : 'placeholder-anon-key',
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: !onPortalRoute } },
);


export interface SupabaseSession {
  user: { id: string };
  access_token?: string;
}

export interface SupabaseUser {
  id: string;
  email?: string | null;
}

export type SupabaseAuthChangeHandler = (event: string, session: SupabaseSession | null) => void;

export interface SupabaseAuthAdapter {
  getSession(): Promise<{ data: { session: SupabaseSession | null }; error: Error | null }>;
  getUser(): Promise<{ data: { user: SupabaseUser | null }; error: Error | null }>;
  onAuthStateChange(handler: SupabaseAuthChangeHandler): {
    data: { subscription: { unsubscribe(): void } };
  };
  signInWithOtp(args: { email: string; options?: { emailRedirectTo?: string; shouldCreateUser?: boolean } }): Promise<{ error: Error | null }>;
  signOut(): Promise<{ error: Error | null }>;
}

// Supabase-js v2 keeps these auth methods at runtime, but some package typings
// expose auth through a narrower class. Centralizing the adapter keeps call sites
// type-safe without weakening repository code.
export const supabaseAuth = supabase.auth as unknown as SupabaseAuthAdapter;
