import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { verifyUnsubscribeToken } from '../_shared/unsubscribe.ts';

// ============================================================================
// ResoFly — Publieke afmeldpagina voor marketingmail (AVG opt-out).
//
// Elke campagnemail draagt een afmeldlink met een HMAC-getekend token
// (<organizationId>:<email>). Deze functie (verify_jwt=false):
//  - GET  → toont een bevestigingspagina met een POST-knop. Bewust POST-to-confirm
//           zodat GET-prefetch door mailclients niet ongewild afmeldt.
//  - POST → zet het adres op de suppressielijst en stopt lopende campagne-sends.
//           Ondersteunt óók de RFC 8058 one-click POST (List-Unsubscribe-Post).
// ============================================================================

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
const UNSUBSCRIBE_SECRET = Deno.env.get('UNSUBSCRIBE_SECRET') || '';

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get('token') || '';

  if (!UNSUBSCRIBE_SECRET) {
    return htmlResponse(page('Afmelden tijdelijk niet mogelijk', 'De afmeldfunctie is nog niet geconfigureerd. Neem contact op met de afzender.'), 500);
  }

  const verified = await verifyUnsubscribeToken(UNSUBSCRIBE_SECRET, token);
  if (!verified) {
    return htmlResponse(page('Ongeldige afmeldlink', 'Deze afmeldlink is ongeldig of verlopen. Neem contact op met de afzender om je af te melden.'), 400);
  }

  const brandName = await loadOrgBrand(verified.organizationId);

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

async function applyUnsubscribe(organizationId: string, email: string, source: string): Promise<void> {
  const normalized = email.trim().toLowerCase();

  await supabaseAdmin
    .from('email_suppressions')
    .upsert(
      { organization_id: organizationId, email: normalized, reason: 'unsubscribed', source },
      { onConflict: 'organization_id,email', ignoreDuplicates: true },
    );

  // Lopende campagne-sends naar dit adres stoppen.
  await supabaseAdmin
    .from('email_campaign_recipients')
    .update({ status: 'unsubscribed', unsubscribed_at: new Date().toISOString() })
    .eq('organization_id', organizationId)
    .eq('to_email', normalized)
    .in('status', ['pending', 'sending']);
}

async function loadOrgBrand(organizationId: string): Promise<string> {
  try {
    const { data: company } = await supabaseAdmin
      .from('company_settings')
      .select('company_name,trade_name')
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (company && (company.trade_name || company.company_name)) {
      return String(company.trade_name || company.company_name);
    }
    const { data: org } = await supabaseAdmin
      .from('organizations')
      .select('name')
      .eq('id', organizationId)
      .maybeSingle();
    return String(org?.name || 'ResoFly');
  } catch {
    return 'ResoFly';
  }
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
