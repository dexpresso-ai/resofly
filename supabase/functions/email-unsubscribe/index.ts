import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { verifyUnsubscribeToken } from '../_shared/unsubscribe.ts';
import { loadSenderName } from '../_shared/emailBrand.ts';

// ============================================================================
// ResoFly — Publieke afmeldpagina voor marketingmail (AVG opt-out).
//
// Elke campagnemail draagt een afmeldlink met een HMAC-getekend token
// (<organizationId>:<email>). Deze functie (verify_jwt=false):
//  - GET  → toont een bevestigingspagina met een POST-knop. Bewust POST-to-confirm
//           zodat GET-prefetch door mailclients niet ongewild afmeldt.
//  - POST → zet het adres op de suppressielijst en stopt lopende campagne-sends.
//           Ondersteunt óók de RFC 8058 one-click POST (List-Unsubscribe-Post).
//
// GEWIJZIGD (10 november 2026): Supabase serveert een GET met text/html op
// *.supabase.co als platte tekst (de rooktest stelde het op staging vast).
// Wie in een campagnemail op "Afmelden" klikte, zag dus HTML-code in plaats van
// de knop. Een browser (Accept: text/html) gaat daarom nu door naar de pagina
// in de app (APP_PUBLIC_URL/afmelden, src/features/PublicUnsubscribePage.tsx),
// en die praat met deze functie via een POST met JSON:
//   {"action":"info","token":…}        → naam van de afzender en het adres;
//   {"action":"unsubscribe","token":…} → afmelden, zelfde stappen als de knop.
// Zonder browser-Accept (en zonder APP_PUBLIC_URL) blijft de oude pagina. De
// one-click POST uit het mailprogramma verandert niet.
// ============================================================================

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
const UNSUBSCRIBE_SECRET = Deno.env.get('UNSUBSCRIBE_SECRET') || '';
const APP_PUBLIC_URL = (Deno.env.get('APP_PUBLIC_URL') || '').replace(/\/+$/, '');

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_CORS });
  if (req.method === 'POST' && (req.headers.get('content-type') || '').toLowerCase().includes('application/json')) {
    return await handleJson(req);
  }
  const token = url.searchParams.get('token') || '';

  // Een browser naar de pagina in de app (zie boven). Het token gaat mee; de
  // pagina controleert het hier opnieuw.
  if ((req.method === 'GET' || req.method === 'HEAD') && APP_PUBLIC_URL && /text\/html/i.test(req.headers.get('accept') || '')) {
    return new Response(null, {
      status: 303,
      headers: {
        Location: `${APP_PUBLIC_URL}/afmelden?token=${encodeURIComponent(token)}`,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
    });
  }

  if (!UNSUBSCRIBE_SECRET) {
    return htmlResponse(page('Afmelden tijdelijk niet mogelijk', 'De afmeldfunctie is nog niet geconfigureerd. Neem contact op met de afzender.'), 500);
  }

  const verified = await verifyUnsubscribeToken(UNSUBSCRIBE_SECRET, token);
  if (!verified) {
    return htmlResponse(page('Ongeldige afmeldlink', 'Deze afmeldlink is ongeldig of verlopen. Neem contact op met de afzender om je af te melden.'), 400);
  }

  // Handelsnaam, bedrijfsnaam of de werkruimte; dezelfde regel als de mail zelf.
  const brandName = await loadSenderName(supabaseAdmin, verified.organizationId);

  if (req.method === 'POST') {
    try {
      await applyUnsubscribe(verified.organizationId, verified.email, 'link');
    } catch (error) {
      console.error('email-unsubscribe apply failed', error instanceof Error ? error.message : error);
      return htmlResponse(page('Er ging iets mis', 'We konden je afmelding niet verwerken. Probeer het later opnieuw.'), 500);
    }
    return htmlResponse(
      page(
        'Je bent afgemeld',
        `Je ontvangt geen marketingmail meer van ${escapeHtml(brandName)} op <strong>${escapeHtml(verified.email)}</strong>.`,
      ),
      200,
    );
  }

  // GET → bevestigingspagina met POST-knop.
  return htmlResponse(confirmPage(brandName, verified.email, token), 200);
});

// Open voor elke herkomst: wat hier gebeurt, mag alleen met een geldig, door
// ons ondertekend token, en er gaat geen cookie of sessie mee. Een andere
// website kon met dat token ook al het formulier posten.
const JSON_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...JSON_CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

/** De ingang voor de afmeldpagina in de app: info of afmelden, met het token in de body. */
async function handleJson(req: Request): Promise<Response> {
  if (!UNSUBSCRIBE_SECRET) return jsonResponse({ error: 'Afmelden is nu niet mogelijk. Neem contact op met de afzender.' }, 503);
  const parsed = await req.json().catch(() => null) as Record<string, unknown> | null;
  const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const action = String(body.action || '');
  if (action !== 'info' && action !== 'unsubscribe') return jsonResponse({ error: 'Onbekende actie.' }, 400);
  const verified = await verifyUnsubscribeToken(UNSUBSCRIBE_SECRET, String(body.token || ''));
  if (!verified) return jsonResponse({ error: 'Deze afmeldlink is ongeldig of verlopen.' }, 400);
  const brandName = await loadSenderName(supabaseAdmin, verified.organizationId);

  if (action === 'unsubscribe') {
    try {
      await applyUnsubscribe(verified.organizationId, verified.email, 'link');
    } catch (error) {
      console.error('email-unsubscribe apply failed', error instanceof Error ? error.message : error);
      return jsonResponse({ error: 'We konden je afmelding niet verwerken. Probeer het later opnieuw.' }, 500);
    }
    return jsonResponse({ brandName, email: verified.email, unsubscribed: true });
  }

  // Staat het adres al als afmelding op de lijst, dan zegt de pagina dat meteen.
  const { data: existing } = await supabaseAdmin.from('email_suppressions').select('reason')
    .eq('organization_id', verified.organizationId).eq('email', verified.email.trim().toLowerCase()).maybeSingle();
  return jsonResponse({ brandName, email: verified.email, unsubscribed: existing?.reason === 'unsubscribed' });
}

// Elke stap controleert zijn fout. supabase-js gooit niet bij een databasefout,
// het geeft { error } terug. Tot november 2026 werd die genegeerd: mislukte het
// wegschrijven, dan las de ontvanger toch "Je bent afgemeld" en bleef hij mail
// krijgen. Nu ziet hij "Er ging iets mis" en kan hij het opnieuw proberen.
async function applyUnsubscribe(organizationId: string, email: string, source: string): Promise<void> {
  const normalized = email.trim().toLowerCase();

  // 1. Op de lijst. De insert-trigger stopt meteen lopende campagnes en stromen.
  const { error: insertError } = await supabaseAdmin
    .from('email_suppressions')
    .upsert(
      { organization_id: organizationId, email: normalized, reason: 'unsubscribed', source },
      { onConflict: 'organization_id,email', ignoreDuplicates: true },
    );
  if (insertError) throw insertError;

  // 2. Stond het adres er al op als handmatige blokkade of bounce, dan wordt
  //    het nu een afmelding van de ontvanger zelf. Die kan het team niet meer
  //    opheffen (migratie 20261107140000); een handmatige blokkade wel. Zonder
  //    deze stap kon het team de blokkade weghalen en de persoon die zich net
  //    had afgemeld weer mailen.
  const { error: upgradeError } = await supabaseAdmin
    .from('email_suppressions')
    .update({ reason: 'unsubscribed', source })
    .eq('organization_id', organizationId)
    .eq('email', normalized)
    .in('reason', ['manual', 'bounced']);
  if (upgradeError) throw upgradeError;

  // 3. Lopende campagne-sends naar dit adres stoppen (ook als stap 1 niets
  //    invoegde omdat het adres er al op stond).
  const { error: stopError } = await supabaseAdmin
    .from('email_campaign_recipients')
    .update({ status: 'unsubscribed', unsubscribed_at: new Date().toISOString() })
    .eq('organization_id', organizationId)
    .eq('to_email', normalized)
    .in('status', ['pending', 'sending']);
  if (stopError) throw stopError;
}

function confirmPage(brandName: string, email: string, token: string): string {
  const action = `?token=${encodeURIComponent(token)}`;
  return shell(
    'Afmelden bevestigen',
    `
    <h1>Afmelden voor marketingmail</h1>
    <p>Wil je je afmelden van marketingmail van ${escapeHtml(brandName)} op <strong>${escapeHtml(email)}</strong>?</p>
    <form method="POST" action="${escapeHtml(action)}">
      <button type="submit" class="btn">Ja, meld mij af</button>
    </form>
    <p class="muted">Belangrijke berichten over lopende zaken (zoals facturen) kun je hierna nog steeds ontvangen.</p>
    `,
  );
}

function page(title: string, message: string): string {
  return shell(title, `<h1>${escapeHtml(title)}</h1><p>${message}</p>`);
}

function shell(title: string, inner: string): string {
  return `<!doctype html>
<html lang="nl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { margin:0; background:#0b0b0b; color:#f5f5f5; font-family:'Poppins',Arial,Helvetica,sans-serif; display:flex; min-height:100vh; align-items:center; justify-content:center; padding:24px; }
      .card { max-width:520px; width:100%; background:#1a1a1a; border:1px solid rgba(255,255,255,.11); border-radius:24px; padding:32px; box-shadow:0 28px 80px rgba(0,0,0,.42); }
      h1 { margin:0 0 14px; font-size:24px; color:#fff; }
      p { margin:0 0 16px; color:#d8d8df; line-height:1.6; font-size:15px; }
      .muted { color:#8e8e8e; font-size:13px; }
      .btn { display:inline-block; background:#ffbd59; color:#111; border:none; font-weight:700; font-size:15px; padding:13px 22px; border-radius:999px; cursor:pointer; }
      .btn:hover { filter:brightness(1.05); }
    </style>
  </head>
  <body>
    <div class="card">${inner}</div>
  </body>
</html>`;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function escapeHtml(value: string): string {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char] || char));
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
