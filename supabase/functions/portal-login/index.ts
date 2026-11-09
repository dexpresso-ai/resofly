import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { loadBranding, type Branding } from '../_shared/branding.ts';
import { isPortalLoginKey } from '../_shared/portalAddress.ts';
import { clientPortalBaseUrl, portalOriginMismatch, portalOriginOf, rememberClientOrigin } from '../_shared/clientLinks.ts';
import { resolveSenderIdentity } from '../_shared/sendingDomain.ts';
import { loadEmailBrand, NO_EMAIL_BRAND, withEmailBrand } from '../_shared/emailBrand.ts';
import { takeEmailQuota } from '../_shared/emailQuota.ts';
import { sanitizeTagValue, sendViaResend } from '../_shared/resend.ts';
import { renderPortalLoginEmail } from '../_shared/emailTemplates/portalLogin.ts';

// ============================================================
// ResoFly — Klantportaal login-provisioning (portal-login)
//
// Publiek eindpunt (verify_jwt = false): wordt aangeroepen VOORDAT de klant is
// ingelogd. Dit project heeft zelf-registratie uitgezet, dus een magische link
// voor een nog onbekend e-mailadres zou falen met "Signups not allowed".
//
// Deze function maakt daarom server-side (service-role) een auth-account aan,
// maar UITSLUITEND voor e-mailadressen die als klant bekend zijn (clients.email).
// Willekeurige e-mailadressen krijgen geen account en geen link.
//
// Sinds migratie 20261108230000 verstuurt deze functie de inlogmail zelf
// (requestLogin met een verifierHash): vanaf het verzenddomein van de
// leverancier, in het Nederlands, met een link naar zijn eigen klantadres.
// Eerst stuurde Supabase hem, met "Your Magic Link" en een link die alleen op
// het adres van ResoFly werkte. De mail bevat alleen een aanvraagnummer; het
// inlogtoken geeft redeemLogin pas aan de browser die met zijn eigen geheim
// bewijst dat hij de aanvraag deed. Zo werkt de link, net als met PKCE, alleen
// in die browser. De code in dezelfde mail is voor wie op een ander apparaat
// leest. Een oude app zonder verifierHash krijgt het oude gedrag (flow 'otp'):
// dan stuurt de frontend zelf de link van Supabase.
//
// De link bouwt de server uit de organisatie, nooit uit het verzoek
// (_shared/clientLinks.ts). Het klantadres waar het verzoek vandaan komt,
// bepaalt alleen bij welke leverancier je inlogt: een filter, geen toegang.
//
// Daarnaast `getBranding`: de huisstijl van het inlogscherm, voor wie het
// portaal opent via het eigen adres van een leverancier (/portal/<sleutel>,
// migratie 20261106080000). Alleen de huisstijl; nooit de organisatie zelf.
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

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
const RESEND_FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || '';
const RESEND_REPLY_TO = Deno.env.get('RESEND_REPLY_TO') || '';
/** Het algemene adres van het portaal, voor wie (nog) geen klantadres heeft. */
const PORTAL_BASE_URL = (Deno.env.get('CLIENT_PORTAL_BASE_URL') || Deno.env.get('APP_PUBLIC_URL') || '').replace(/\/+$/, '');
/** Zo lang werkt een inlogmail. */
const LOGIN_REQUEST_MINUTES = 15;
/** Na zoveel verkeerde browsers is de link op. */
const LOGIN_REQUEST_MAX_ATTEMPTS = 5;

class PortalLoginError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

serve(async (req) => {
  // Van een klantadres (jansen.resofly.com, portaal.jansen.nl)? Eén keer
  // opzoeken; CORS en de controle of de link bij dat adres hoort, lezen het
  // daarna (_shared/clientLinks.ts).
  await rememberClientOrigin(supabaseAdmin, req);
  if (req.method === 'OPTIONS') return json(req, { ok: true });

  try {
    assertAllowedOrigin(req);
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Method not allowed.' }, 405);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || 'requestLogin');
    if (action === 'getBranding') return json(req, { ok: true, branding: await brandingFor(req, body.key) });
    if (action === 'redeemLogin') return json(req, { ok: true, ...(await redeemLogin(req, body)) });
    if (action !== 'requestLogin') throw new PortalLoginError(`Onbekende actie: ${action}`, 400);

    const email = String(body.email || '').trim().toLowerCase();
    if (!isEmail(email)) throw new PortalLoginError('Vul een geldig e-mailadres in.', 400);

    // Een rem (migratie 20261101080000): per afzender en per e-mailadres. Boven
    // de grens hetzelfde antwoord als altijd, maar zonder opzoeken en zonder
    // account: anders is dit een gratis accountfabriek, een mailbom en een
    // opzoekdienst voor "is dit iemands klant?".
    if (await portalLoginThrottled(req, email)) return json(req, { ok: true, known: true });

    // Een nieuwe app stuurt de hash van zijn eigen geheim mee: dan verstuurt
    // deze functie de inlogmail. Een oude app niet: dan doet hij dat zelf, via
    // Supabase (flow 'otp'), zoals voorheen.
    const verifierHash = String(body.verifierHash || '').toLowerCase();
    const sendsMail = /^[0-9a-f]{64}$/.test(verifierHash);
    const flow = sendsMail ? 'mail' : 'otp';

    // Toegang is afgeleid uit clients.email: alleen bekende klanten krijgen een
    // account. Onbekende adressen worden NIET aangemaakt (geen open registratie,
    // geen enumeratie van geldige adressen via side effects).
    const { data: clients, error: lookupError } = await supabaseAdmin.rpc('portal_clients_for_email', { p_email: email });
    if (lookupError) throw lookupError;
    const organizations = [...new Set(((Array.isArray(clients) ? clients : []) as Array<{ organization_id?: string }>)
      .map((row) => String(row.organization_id ?? '')).filter(Boolean))];
    // Op het klantadres of het eigen inlogadres van een leverancier log je in
    // bij díe leverancier: een filter, nooit extra toegang.
    const scope = await loginOrganization(req, body.key);
    const known = scope ? organizations.includes(scope) : organizations.length > 0;

    if (known && sendsMail) {
      // Eén leverancier: zijn naam, zijn afzender en zijn adres. Meer dan één en
      // geen keuze in het adres: het algemene portaal, waar de klant kiest.
      const organizationId = scope ?? (organizations.length === 1 ? organizations[0] : null);
      // Na het antwoord: anders duurde het antwoord voor een bekend adres
      // merkbaar langer (account, inlogtoken, mail), en las je aan de tijd af
      // of iemand klant is. Een fout komt in de log, nooit in het antwoord.
      await afterResponse((async () => {
        await ensureAuthUser(email);
        await sendLoginMail(email, organizationId, verifierHash);
      })().catch((error) => console.error('portal-login: inlogmail versturen mislukt', describeError(error))));
    } else if (known) {
      // De oude app logt daarna zelf in via Supabase: het account moet er dan al zijn.
      await ensureAuthUser(email);
    }
    // Het antwoord is voor elk adres hetzelfde: anders is deze functie een
    // opzoekdienst voor "is dit iemands klant?". Een onbekend adres krijgt
    // gewoon geen inloglink. `known: true` blijft staan voor oudere frontends,
    // die zonder die vlag niet doorgaan naar het versturen van de link.
    return json(req, { ok: true, known: true, flow });
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

/**
 * Bij welke leverancier log je in? Het klantadres waar het verzoek vandaan
 * komt, of anders de sleutel van het eigen inlogadres (/portal/<sleutel>).
 * Null: het algemene portaal.
 */
async function loginOrganization(req: Request, rawKey: unknown): Promise<string | null> {
  const client = portalOriginOf(req);
  if (client) return client.organizationId;
  if (!isPortalLoginKey(rawKey)) return null;
  const { data, error } = await supabaseAdmin.from('portal_login_addresses').select('organization_id').eq('key', rawKey).maybeSingle();
  if (error) return null;
  const organizationId = (data as { organization_id?: unknown } | null)?.organization_id;
  return typeof organizationId === 'string' && organizationId ? organizationId : null;
}

/**
 * Maakt een inlogtoken (Supabase verstuurt daarbij niets), bewaart het bij een
 * willekeurig aanvraagnummer, en mailt de link met dat nummer en de code.
 */
async function sendLoginMail(email: string, organizationId: string | null, verifierHash: string): Promise<void> {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) throw new Error('RESEND_API_KEY of RESEND_FROM_EMAIL ontbreekt.');
  // Het portaal woont op de naam bij ResoFly, nooit op een eigen domein (zie
  // clientPortalBaseUrl): daar komt de sessie van de klant te staan.
  const base = organizationId ? await clientPortalBaseUrl(supabaseAdmin, organizationId, PORTAL_BASE_URL) : PORTAL_BASE_URL;
  if (!base) throw new Error('APP_PUBLIC_URL (of CLIENT_PORTAL_BASE_URL) ontbreekt: zonder kan de mail niet naar het portaal linken.');
  if (organizationId) {
    await takeEmailQuota(supabaseAdmin, organizationId, 1, (message, status) => new PortalLoginError(message, status));
  }

  const { data: link, error: linkError } = await supabaseAdmin.auth.admin.generateLink({ type: 'magiclink', email });
  if (linkError) throw linkError;
  const tokenHash = String(link?.properties?.hashed_token ?? '');
  const code = String(link?.properties?.email_otp ?? '') || null;
  if (!tokenHash) throw new Error('Supabase gaf geen inlogtoken terug.');

  const requestId = randomToken();
  const requestHash = await sha256Hex(requestId);
  const { error: insertError } = await supabaseAdmin.from('portal_login_requests').insert({
    request_hash: requestHash,
    organization_id: organizationId,
    email,
    token_hash: tokenHash,
    verifier_hash: verifierHash,
    expires_at: new Date(Date.now() + LOGIN_REQUEST_MINUTES * 60_000).toISOString(),
  });
  if (insertError) throw insertError;

  const loginUrl = `${base}/portal/inloggen?aanvraag=${encodeURIComponent(requestId)}`;
  const branding = organizationId ? await loadBranding(supabaseAdmin, organizationId) : null;
  const sender = organizationId
    ? await resolveSenderIdentity(supabaseAdmin, organizationId, RESEND_FROM_EMAIL, RESEND_REPLY_TO)
    : { from: RESEND_FROM_EMAIL, replyTo: RESEND_REPLY_TO || undefined };
  const brand = organizationId ? await loadEmailBrand(supabaseAdmin, organizationId) : NO_EMAIL_BRAND;
  const mail = renderPortalLoginEmail({
    supplierName: branding?.companyName ?? null,
    accentColor: branding?.accentColor ?? null,
    loginUrl,
    code,
    minutes: LOGIN_REQUEST_MINUTES,
  });
  await sendViaResend(RESEND_API_KEY, withEmailBrand({
    from: sender.from,
    to: [email],
    ...(sender.replyTo ? { reply_to: sender.replyTo } : {}),
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    tags: [
      { name: 'type', value: 'portal_login' },
      ...(organizationId ? [{ name: 'organization_id', value: sanitizeTagValue(organizationId) }] : []),
    ],
  }, brand), `portal-login-${requestHash.slice(0, 40)}`);
}

/**
 * De link uit de inlogmail inwisselen. De browser stuurt het aanvraagnummer
 * en zijn eigen geheimen mee (hooguit vijf: wie twee keer aanvroeg, heeft er
 * twee); past er één bij de aanvraag, dan krijgt hij het inlogtoken en wisselt
 * hij dat zelf in bij Supabase. Eén keer te gebruiken, een kwartier geldig.
 */
async function redeemLogin(req: Request, body: Record<string, unknown>) {
  const requestId = String(body.request ?? '');
  if (!/^[A-Za-z0-9_-]{30,100}$/.test(requestId)) throw new PortalLoginError('Deze inloglink is ongeldig. Vraag een nieuwe aan.', 400);
  const verifiers = (Array.isArray(body.verifiers) ? body.verifiers : [])
    .filter((value): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{30,100}$/.test(value))
    .slice(0, 5);

  // Een rem per afzender: het aanvraagnummer is niet te raden (32 bytes), maar
  // dit is geen plek om eindeloos te proberen.
  if (await throttleHit(await sha256Hex(`portal-redeem:ip:${senderAddress(req)}`), 600, 30, 900) > 0) {
    throw new PortalLoginError('Te veel pogingen. Wacht een kwartier en probeer het opnieuw.', 429);
  }

  const { data, error } = await supabaseAdmin.from('portal_login_requests')
    .select('id,organization_id,email,token_hash,verifier_hash,attempts,expires_at,used_at')
    .eq('request_hash', await sha256Hex(requestId))
    .maybeSingle();
  if (error) throw error;
  const row = data as {
    id: string; organization_id: string | null; email: string; token_hash: string; verifier_hash: string;
    attempts: number; expires_at: string; used_at: string | null;
  } | null;
  if (!row || row.used_at || Date.parse(row.expires_at) <= Date.now()) {
    throw new PortalLoginError('Deze inloglink is verlopen of al gebruikt. Vraag een nieuwe aan.', 410);
  }
  // Een link van een andere leverancier op dit klantadres: alsof hij niet bestaat.
  if (row.organization_id && portalOriginMismatch(req, row.organization_id)) {
    throw new PortalLoginError('Deze inloglink is verlopen of al gebruikt. Vraag een nieuwe aan.', 410);
  }

  const hashes = await Promise.all(verifiers.map((value) => sha256Hex(value)));
  if (!hashes.some((hash) => timingSafeEqual(hash, row.verifier_hash))) {
    const attempts = (row.attempts ?? 0) + 1;
    await supabaseAdmin.from('portal_login_requests')
      .update({ attempts, ...(attempts >= LOGIN_REQUEST_MAX_ATTEMPTS ? { used_at: new Date().toISOString() } : {}) })
      .eq('id', row.id);
    throw new PortalLoginError('Deze inloglink hoort bij een andere browser. Open hem in de browser waarin je de link aanvroeg, of vul daar de code uit de mail in.', 403);
  }

  // Eén keer: wie tegelijk twee keer klikt, krijgt het token maar één keer.
  const { data: claimed, error: claimError } = await supabaseAdmin.from('portal_login_requests')
    .update({ used_at: new Date().toISOString() })
    .eq('id', row.id).is('used_at', null)
    .select('id');
  if (claimError) throw claimError;
  if (!claimed || claimed.length === 0) throw new PortalLoginError('Deze inloglink is verlopen of al gebruikt. Vraag een nieuwe aan.', 410);

  const portalKey = row.organization_id ? await portalKeyFor(row.organization_id) : null;
  return { tokenHash: row.token_hash, email: row.email, portalKey };
}

async function portalKeyFor(organizationId: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from('portal_login_addresses').select('key').eq('organization_id', organizationId).maybeSingle();
  const key = (data as { key?: unknown } | null)?.key;
  return isPortalLoginKey(key) ? key : null;
}

/** De huisstijl van het inlogscherm: van het klantadres, of bij de sleutel uit het adres. */
async function brandingFor(req: Request, rawKey: unknown): Promise<Branding | null> {
  const client = portalOriginOf(req);
  if (!client) return brandingForKey(req, rawKey);
  if (await throttleHit(await sha256Hex(`portal-brand:ip:${senderAddress(req)}`), 600, 120, 600) > 0) return null;
  return loadBranding(supabaseAdmin, client.organizationId);
}

/**
 * Werk dat na het antwoord doorloopt (EdgeRuntime.waitUntil). Zonder die
 * runtime (de stromentest in Node) wachten we er gewoon op.
 */
async function afterResponse(task: Promise<unknown>): Promise<void> {
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime;
  if (typeof runtime?.waitUntil === 'function') {
    runtime.waitUntil(task);
    return;
  }
  await task;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

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
  if (portalOriginOf(req)) return;
  if (allowedOrigins.includes(origin)) return;
  throw new PortalLoginError('Deze frontend-origin is niet toegestaan voor het klantportaal.', 403);
}

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get('origin') || '';
  const allowOrigin = portalOriginOf(req) || allowedOrigins.includes(origin) ? origin : allowedOrigins.length === 0 ? '*' : '';
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
