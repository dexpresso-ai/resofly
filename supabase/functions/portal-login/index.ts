import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

// ============================================================
// ResoFly — Klantportaal login-provisioning (portal-login)
//
// Publiek eindpunt (verify_jwt = false): wordt aangeroepen VOORDAT de klant is
// ingelogd. Dit project heeft zelf-registratie uitgezet, dus een magische link
// voor een nog onbekend e-mailadres zou falen met "Signups not allowed".
//
// Deze function maakt daarom server-side (service-role) een auth-account aan,
// maar UITSLUITEND voor e-mailadressen die als klant bekend zijn (clients.email).
// Daarna stuurt de frontend de magische link via signInWithOtp (de gebruiker
// bestaat dan al, dus zonder zelf-registratie). Willekeurige e-mailadressen
// krijgen geen account en geen link.
// ============================================================

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');

const allowedOrigins = parseAllowedOrigins([
  Deno.env.get('CLIENT_PORTAL_ALLOWED_ORIGINS'),
  Deno.env.get('APP_PUBLIC_URL'),
  Deno.env.get('INVOICE_PUBLIC_ALLOWED_ORIGINS'),
  Deno.env.get('QUOTE_PUBLIC_ALLOWED_ORIGINS'),
]);

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

class PortalLoginError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return json(req, { ok: true });

  try {
    assertAllowedOrigin(req);
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Method not allowed.' }, 405);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || 'requestLogin');
    if (action !== 'requestLogin') throw new PortalLoginError(`Onbekende actie: ${action}`, 400);

    const email = String(body.email || '').trim().toLowerCase();
    if (!isEmail(email)) throw new PortalLoginError('Vul een geldig e-mailadres in.', 400);

    // Toegang is afgeleid uit clients.email: alleen bekende klanten krijgen een
    // account. Onbekende adressen worden NIET aangemaakt (geen open registratie,
    // geen enumeratie van geldige adressen via side effects).
    const { data: clients, error: lookupError } = await supabaseAdmin.rpc('portal_clients_for_email', { p_email: email });
    if (lookupError) throw lookupError;
    const known = Array.isArray(clients) && clients.length > 0;

    if (!known) {
      return json(req, { ok: true, known: false });
    }

    await ensureAuthUser(email);
    return json(req, { ok: true, known: true });
  } catch (error) {
    const status = error instanceof PortalLoginError ? error.status : 500;
    const message = error instanceof PortalLoginError
      ? error.message
      : `Inloggen kon niet worden voorbereid: ${describeError(error)}`.slice(0, 500);
    if (status >= 500) {
      console.error('portal-login error', describeError(error), error instanceof Error ? error.stack : undefined);
    }
    return json(req, { ok: false, error: message }, status);
  }
});

/** Maakt het auth-account aan als het nog niet bestaat. Idempotent: een al
 *  bestaand account is geen fout. email_confirm = true zodat de magische link
 *  direct werkt zonder aparte bevestigingsstap. */
async function ensureAuthUser(email: string): Promise<void> {
  const { error } = await supabaseAdmin.auth.admin.createUser({ email, email_confirm: true });
  if (!error) return;
  // Bestaat al → prima, dit is het gewenste eindresultaat.
  const message = (error.message || '').toLowerCase();
  if (message.includes('already') || message.includes('registered') || message.includes('exists')) return;
  throw error;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || 'Error';
  if (error && typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof obj.message === 'string' && obj.message) parts.push(obj.message);
    if (typeof obj.code === 'string' && obj.code) parts.push(`(code ${obj.code})`);
    if (typeof obj.details === 'string' && obj.details) parts.push(`details: ${obj.details}`);
    if (parts.length) return parts.join(' ');
    try { return JSON.stringify(obj); } catch { /* val terug op String() */ }
  }
  return String(error);
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function parseAllowedOrigins(values: Array<string | null | undefined>): string[] {
  const origins = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const rawPart of value.split(',')) {
      const part = rawPart.trim().replace(/\/$/, '');
      if (!part) continue;
      try { origins.add(new URL(part).origin); } catch { origins.add(part); }
    }
  }
  return Array.from(origins);
}

function assertAllowedOrigin(req: Request) {
  const origin = req.headers.get('origin') || '';
  if (!origin) return;
  if (allowedOrigins.includes(origin)) return;
  throw new PortalLoginError('Deze frontend-origin is niet toegestaan voor het klantportaal.', 403);
}

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get('origin') || '';
  const allowOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins.length === 0 ? '*' : 'null';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function json(req: Request, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } });
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
