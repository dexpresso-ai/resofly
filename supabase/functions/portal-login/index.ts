import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { loadBranding, type Branding } from '../_shared/branding.ts';
import { isPortalLoginKey } from '../_shared/portalAddress.ts';

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
//
// Daarnaast `getBranding`: de huisstijl van het inlogscherm, voor wie het
// portaal opent via het eigen adres van een leverancier (/portal/<sleutel>,
// migratie 20261105110000). Alleen de huisstijl; nooit de organisatie zelf.
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
    if (action === 'getBranding') return json(req, { ok: true, branding: await brandingForKey(req, body.key) });
    if (action !== 'requestLogin') throw new PortalLoginError(`Onbekende actie: ${action}`, 400);

    const email = String(body.email || '').trim().toLowerCase();
    if (!isEmail(email)) throw new PortalLoginError('Vul een geldig e-mailadres in.', 400);

    // Een rem (migratie 20261101080000): per afzender en per e-mailadres. Boven
    // de grens hetzelfde antwoord als altijd, maar zonder opzoeken en zonder
    // account: anders is dit een gratis accountfabriek, een mailbom en een
    // opzoekdienst voor "is dit iemands klant?".
    if (await portalLoginThrottled(req, email)) return json(req, { ok: true, known: true });

    // Toegang is afgeleid uit clients.email: alleen bekende klanten krijgen een
    // account. Onbekende adressen worden NIET aangemaakt (geen open registratie,
    // geen enumeratie van geldige adressen via side effects).
    const { data: clients, error: lookupError } = await supabaseAdmin.rpc('portal_clients_for_email', { p_email: email });
    if (lookupError) throw lookupError;
    const known = Array.isArray(clients) && clients.length > 0;

    if (known) await ensureAuthUser(email);
    // Het antwoord is voor elk adres hetzelfde: anders is deze functie een
    // opzoekdienst voor "is dit iemands klant?". Een onbekend adres krijgt
    // gewoon geen inloglink. `known: true` blijft staan voor oudere frontends,
    // die zonder die vlag niet doorgaan naar het versturen van de link.
    return json(req, { ok: true, known: true });
  } catch (error) {
    const status = error instanceof PortalLoginError ? error.status : 500;
    // Details alleen in de log; een bezoeker zonder account krijgt geen interne foutteksten.
    const message = error instanceof PortalLoginError
      ? error.message
      : 'Inloggen kon niet worden voorbereid. Probeer het later opnieuw.';
    if (status >= 500) {
      console.error('portal-login error', describeError(error), error instanceof Error ? error.stack : undefined);
    }
    return json(req, { ok: false, error: message }, status);
  }
});

function senderAddress(req: Request): string {
  return (req.headers.get('cf-connecting-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0] || 'onbekend')
    .trim().slice(0, 64);
}

/** Telt één aanvraag op deze sleutel; geeft het aantal seconden wachten (0 = door). */
async function throttleHit(key: string, windowSeconds: number, max: number, blockSeconds: number): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc('portal_login_hit', {
    p_key: key, p_window_seconds: windowSeconds, p_max_attempts: max, p_block_seconds: blockSeconds,
  });
  // Een kapotte teller (migratie nog niet gedraaid) mag het inloggen niet blokkeren.
  if (error) { console.warn('portal_login_hit mislukt', error.message); return 0; }
  return Number(data) || 0;
}

/** Telt deze aanvraag; true als de afzender of het adres even moet wachten. */
async function portalLoginThrottled(req: Request, email: string): Promise<boolean> {
  const [ipKey, emailKey] = await Promise.all([
    sha256Hex(`portal-login:ip:${senderAddress(req)}`),
    sha256Hex(`portal-login:email:${email}`),
  ]);
  // 20 per 10 minuten per afzender; 5 per uur per e-mailadres.
  const [ipWait, emailWait] = await Promise.all([throttleHit(ipKey, 600, 20, 900), throttleHit(emailKey, 3600, 5, 3600)]);
  return ipWait > 0 || emailWait > 0;
}

/**
 * De huisstijl van het inlogscherm bij een sleutel uit het adres. Alleen wat
 * `loadBranding` naar buiten laat (logo, naam, kleuren, letters, afsluiting),
 * nooit het id of de gegevens van de organisatie. Een onbekende of ongeldige
 * sleutel geeft null: dan is het inlogscherm neutraal, net als op /portal.
 *
 * Met een eigen rem per afzender: de sleutel is niet te raden (tien
 * willekeurige tekens), maar een antwoord met twee logo's is een paar honderd
 * kB, en dat hoort niemand eindeloos te kunnen opvragen.
 */
async function brandingForKey(req: Request, raw: unknown): Promise<Branding | null> {
  if (!isPortalLoginKey(raw)) return null;
  // 120 per 10 minuten per afzender: ruim voor een kantoor achter één adres.
  if (await throttleHit(await sha256Hex(`portal-brand:ip:${senderAddress(req)}`), 600, 120, 600) > 0) return null;
  const { data, error } = await supabaseAdmin
    .from('portal_login_addresses')
    .select('organization_id')
    .eq('key', raw)
    .maybeSingle();
  if (error) {
    // Ook: de migratie met de tabel staat er nog niet. Dan neutraal.
    console.warn('portal-login inlogadres opzoeken mislukt', error.message);
    return null;
  }
  const organizationId = (data as { organization_id?: unknown } | null)?.organization_id;
  if (typeof organizationId !== 'string' || !organizationId) return null;
  return loadBranding(supabaseAdmin, organizationId);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Maakt het auth-account aan als het nog niet bestaat. Idempotent: een al
 *  bestaand account is geen fout. email_confirm = true zodat de magische link
 *  direct werkt zonder aparte bevestigingsstap.
 *
 *  app_metadata.resofly_portal markeert het als klantaccount: zo'n account
 *  krijgt in de werkruimte geen eigen organisatie (is_portal_only_account,
 *  migratie 20261101010000). app_metadata kan alleen de server zetten, de
 *  gebruiker zelf niet. Een bestaand account (bijvoorbeeld een teamlid dat ook
 *  klant is) wordt niet aangeraakt. */
async function ensureAuthUser(email: string): Promise<void> {
  const { error } = await supabaseAdmin.auth.admin.createUser({
    email,
    email_confirm: true,
    app_metadata: { resofly_portal: true },
  });
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
  // Een pagina zonder herkomst (sandbox-iframe, data:, file:) is nooit de app.
  if (origin === 'null') throw new PortalLoginError('Verzoeken zonder herkomst (origin "null") worden niet geaccepteerd.', 403);
  if (!origin) return;
  if (allowedOrigins.includes(origin)) return;
  throw new PortalLoginError('Deze frontend-origin is niet toegestaan voor het klantportaal.', 403);
}

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get('origin') || '';
  const allowOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins.length === 0 ? '*' : '';
  return {
    ...(allowOrigin ? { 'Access-Control-Allow-Origin': allowOrigin } : {}),
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
