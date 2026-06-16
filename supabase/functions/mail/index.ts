import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer';
type MailHttpErrorStatus = 400 | 401 | 403 | 404 | 422 | 500 | 502;

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
const RESEND_FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || '';
const RESEND_REPLY_TO = Deno.env.get('RESEND_REPLY_TO') || '';

// Basis-URL van de frontend voor de portaallink in de welkomstmail. Valt terug op
// de (al via assertAllowedOrigin gevalideerde) request-origin als er geen env staat.
const CLIENT_PORTAL_BASE_URL = (
  Deno.env.get('CLIENT_PORTAL_BASE_URL') ||
  Deno.env.get('APP_PUBLIC_URL') ||
  Deno.env.get('QUOTE_PUBLIC_BASE_URL') ||
  Deno.env.get('INVOICE_PUBLIC_BASE_URL') ||
  ''
).replace(/\/$/, '');

const MAIL_ALLOWED_ORIGINS = (
  Deno.env.get('MAIL_ALLOWED_ORIGINS') ||
  Deno.env.get('QUOTE_ALLOWED_ORIGINS') ||
  Deno.env.get('BILLING_ALLOWED_RETURN_ORIGINS') ||
  ''
)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const MAIL_ALLOW_LOCAL_DEV =
  (Deno.env.get('MAIL_ALLOW_LOCAL_DEV') || 'false').toLowerCase() === 'true';

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

class MailHttpError extends Error {
  status: MailHttpErrorStatus;

  constructor(message: string, status: MailHttpErrorStatus = 400) {
    super(message);
    this.name = 'MailHttpError';
    this.status = status;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return json(req, { ok: true });
  }

  try {
    assertAllowedOrigin(req);

    if (req.method !== 'POST') {
      return json(req, { ok: false, error: 'Method not allowed.' }, 405);
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const action = String(body.action || '');
    const organizationId = String(body.organizationId || '');

    const user = await requireUser(req);
    const role = await requireOrganizationAccess(user.id, organizationId);

    switch (action) {
      case 'sendTestEmail': {
        if (!['owner', 'admin'].includes(role)) {
          throw new MailHttpError(
            'Alleen owners en admins kunnen Resend-testmails verzenden.',
            403,
          );
        }

        const result = await sendTestEmail(organizationId, body);
        return json(req, { ok: true, ...result });
      }

      case 'sendClientPortalWelcome': {
        if (!['owner', 'admin', 'member'].includes(role)) {
          throw new MailHttpError(
            'Je hebt geen rechten om de welkomstmail te versturen.',
            403,
          );
        }

        const result = await sendClientPortalWelcome(req, organizationId, body);
        return json(req, { ok: true, ...result });
      }

      default:
        return json(
          req,
          { ok: false, error: `Onbekende mail action: ${action}` },
          400,
        );
    }
  } catch (error) {
    const status = error instanceof MailHttpError ? error.status : 500;
    const internalMessage =
      error instanceof Error ? error.message : 'Onbekende fout.';

    if (status >= 500) {
      console.error('mail function error', internalMessage);
    }

    const publicMessage =
      error instanceof MailHttpError
        ? error.message
        : 'Mailactie mislukt door een server- of providerfout. Controleer de Edge Function logs.';

    return json(req, { ok: false, error: publicMessage }, status);
  }
});

async function sendTestEmail(
  organizationId: string,
  body: Record<string, unknown>,
): Promise<{ providerEmailId: string; recipientEmail: string }> {
  if (!RESEND_API_KEY) {
    throw new MailHttpError(
      'RESEND_API_KEY ontbreekt in de Edge Function secrets.',
      500,
    );
  }

  if (!RESEND_FROM_EMAIL) {
    throw new MailHttpError(
      'RESEND_FROM_EMAIL ontbreekt in de Edge Function secrets.',
      500,
    );
  }

  const recipientEmail = String(body.recipientEmail || '')
    .trim()
    .toLowerCase();

  const recipientName = String(body.recipientName || '').trim();

  if (!isEmail(recipientEmail)) {
    throw new MailHttpError(
      'Vul een geldig e-mailadres in voor de testmail.',
      422,
    );
  }

  const organization = await loadOrganization(organizationId);
  const company = await loadCompanySettings(organizationId);

  const organizationName =
    company?.trade_name ||
    company?.company_name ||
    organization.name ||
    'ResoFly';

  const subject = `Resend testmail vanuit ${organizationName}`;
  const html = buildTestEmailHtml({ organizationName, recipientName });
  const text = buildTestEmailText({ organizationName, recipientName });

  const resendPayload = await sendViaResend(
    {
      from: RESEND_FROM_EMAIL,
      to: [recipientEmail],
      reply_to: RESEND_REPLY_TO || undefined,
      subject,
      html,
      text,
    },
    `mail-test-${sanitizeIdempotencyPart(organizationId)}-${crypto.randomUUID()}`,
  );

  const providerEmailId = String(
    resendPayload.id || resendPayload.email_id || '',
  ).trim();

  if (!providerEmailId) {
    throw new MailHttpError(
      'Resend heeft de testmail aangenomen, maar gaf geen e-mail-ID terug.',
      502,
    );
  }

  return {
    providerEmailId,
    recipientEmail,
  };
}

async function sendClientPortalWelcome(
  req: Request,
  organizationId: string,
  body: Record<string, unknown>,
): Promise<{ providerEmailId: string; recipientEmail: string }> {
  if (!RESEND_API_KEY) {
    throw new MailHttpError('RESEND_API_KEY ontbreekt in de Edge Function secrets.', 500);
  }
  if (!RESEND_FROM_EMAIL) {
    throw new MailHttpError('RESEND_FROM_EMAIL ontbreekt in de Edge Function secrets.', 500);
  }

  const clientId = String(body.clientId || '').trim();
  if (!isUuid(clientId)) {
    throw new MailHttpError('Ongeldige klant.', 400);
  }

  const client = await loadClient(organizationId, clientId);
  const recipientEmail = String(client.email || '').trim().toLowerCase();
  if (!isEmail(recipientEmail)) {
    throw new MailHttpError(
      'Deze klant heeft geen geldig e-mailadres, dus er kan geen welkomstmail worden verstuurd.',
      422,
    );
  }

  const organization = await loadOrganization(organizationId);
  const company = await loadCompanySettings(organizationId);
  const organizationName =
    company?.trade_name || company?.company_name || organization.name || 'ResoFly';

  const portalUrl = `${resolvePortalBaseUrl(req)}/portal`;
  const recipientName = String(client.contact_name || client.name || '').trim();

  const subject = `Welkom bij ${organizationName} — je klantportaal staat klaar`;
  const html = buildClientWelcomeHtml({ organizationName, recipientName, recipientEmail, portalUrl });
  const text = buildClientWelcomeText({ organizationName, recipientName, recipientEmail, portalUrl });

  const resendPayload = await sendViaResend(
    {
      from: RESEND_FROM_EMAIL,
      to: [recipientEmail],
      reply_to: RESEND_REPLY_TO || undefined,
      subject,
      html,
      text,
    },
    `client-welcome-${sanitizeIdempotencyPart(organizationId)}-${sanitizeIdempotencyPart(clientId)}`,
  );

  const providerEmailId = String(resendPayload.id || resendPayload.email_id || '').trim();
  if (!providerEmailId) {
    throw new MailHttpError(
      'Resend heeft de welkomstmail aangenomen, maar gaf geen e-mail-ID terug.',
      502,
    );
  }

  return { providerEmailId, recipientEmail };
}

async function loadClient(
  organizationId: string,
  clientId: string,
): Promise<{ id: string; name: string; contact_name: string | null; email: string | null }> {
  const { data, error } = await supabaseAdmin
    .from('clients')
    .select('id,name,contact_name,email')
    .eq('id', clientId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data) {
    throw new MailHttpError('Klant niet gevonden.', 404);
  }

  return data as { id: string; name: string; contact_name: string | null; email: string | null };
}

function resolvePortalBaseUrl(req: Request): string {
  if (CLIENT_PORTAL_BASE_URL) return CLIENT_PORTAL_BASE_URL;
  // De origin is hierboven al gevalideerd via assertAllowedOrigin, dus veilig als basis.
  return (req.headers.get('origin') || '').replace(/\/$/, '');
}

function buildClientWelcomeHtml(input: {
  organizationName: string;
  recipientName: string;
  recipientEmail: string;
  portalUrl: string;
}): string {
  const name = escapeHtml(input.recipientName || 'daar');
  const org = escapeHtml(input.organizationName);
  const email = escapeHtml(input.recipientEmail);
  const url = escapeHtml(input.portalUrl);

  return `<!doctype html>
<html>
  <body style="margin:0;background:#111111;font-family:Arial,sans-serif;color:#f5f5f5;">
    <div style="max-width:640px;margin:0 auto;padding:32px 20px;">
      <div style="background:#1b1b1f;border:1px solid #303038;border-radius:24px;padding:28px;">
        <p style="margin:0 0 8px;color:#FFD966;font-size:13px;text-transform:uppercase;letter-spacing:.08em;">
          ${org}
        </p>

        <h1 style="margin:0 0 16px;font-size:26px;line-height:1.2;color:#ffffff;">
          Welkom in je klantportaal
        </h1>

        <p style="margin:0 0 16px;color:#d8d8df;font-size:16px;line-height:1.6;">
          Hoi ${name},<br/>
          ${org} werkt met een online klantportaal. Daar vind je op één plek je
          <strong>facturen, offertes, tickets en lopende projecten</strong>.
        </p>

        <p style="margin:0 0 24px;color:#d8d8df;font-size:16px;line-height:1.6;">
          Inloggen kan zonder wachtwoord: ga naar het portaal en vul je e-mailadres
          (<strong>${email}</strong>) in. Je ontvangt dan een veilige inloglink in je mailbox.
        </p>

        <a href="${url}" style="display:inline-block;background:#FFD966;color:#1a1a1a;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 22px;border-radius:10px;">
          Open het klantportaal
        </a>

        <p style="margin:24px 0 0;color:#9b9ba7;font-size:13px;line-height:1.5;">
          Werkt de knop niet? Kopieer deze link naar je browser:<br/>${url}
        </p>
      </div>
      <p style="margin:16px 4px 0;color:#6f6f78;font-size:12px;line-height:1.5;">
        Je ontvangt deze e-mail omdat ${org} een klantdossier voor je heeft aangemaakt.
      </p>
    </div>
  </body>
</html>`;
}

function buildClientWelcomeText(input: {
  organizationName: string;
  recipientName: string;
  recipientEmail: string;
  portalUrl: string;
}): string {
  return [
    input.organizationName,
    'Welkom in je klantportaal',
    '',
    `Hoi ${input.recipientName || 'daar'},`,
    `${input.organizationName} werkt met een online klantportaal. Daar vind je op één plek je facturen, offertes, tickets en lopende projecten.`,
    '',
    `Inloggen kan zonder wachtwoord: ga naar ${input.portalUrl} en vul je e-mailadres (${input.recipientEmail}) in. Je ontvangt dan een veilige inloglink in je mailbox.`,
    '',
    `Open het klantportaal: ${input.portalUrl}`,
    '',
    `Je ontvangt deze e-mail omdat ${input.organizationName} een klantdossier voor je heeft aangemaakt.`,
  ].join('\n');
}

async function sendViaResend(
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey.slice(0, 256),
    },
    body: JSON.stringify(payload),
  });

  const responsePayload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (!response.ok) {
    console.error('Resend send failed', responsePayload);

    const providerMessage = String(
      responsePayload.message ||
        responsePayload.error ||
        response.statusText ||
        'Resend send failed',
    );

    throw new MailHttpError(
      `Resend kon de e-mail niet versturen: ${providerMessage}`,
      502,
    );
  }

  return responsePayload;
}

async function loadOrganization(
  organizationId: string,
): Promise<{ id: string; name: string }> {
  if (!isUuid(organizationId)) {
    throw new MailHttpError('Ongeldige organisatie.', 400);
  }

  const { data, error } = await supabaseAdmin
    .from('organizations')
    .select('id,name')
    .eq('id', organizationId)
    .single();

  if (error || !data) {
    throw new MailHttpError('Organisatie niet gevonden.', 404);
  }

  return data as { id: string; name: string };
}

async function loadCompanySettings(
  organizationId: string,
): Promise<{ company_name: string; trade_name: string | null } | null> {
  const { data, error } = await supabaseAdmin
    .from('company_settings')
    .select('company_name,trade_name')
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data ?? null) as {
    company_name: string;
    trade_name: string | null;
  } | null;
}

function buildTestEmailHtml(input: {
  organizationName: string;
  recipientName: string;
}): string {
  const name = escapeHtml(input.recipientName || 'Gerjan');
  const organizationName = escapeHtml(input.organizationName);

  return `<!doctype html>
<html>
  <body style="margin:0;background:#111111;font-family:Arial,sans-serif;color:#f5f5f5;">
    <div style="max-width:640px;margin:0 auto;padding:32px 20px;">
      <div style="background:#1b1b1f;border:1px solid #303038;border-radius:24px;padding:28px;">
        <p style="margin:0 0 8px;color:#FFD966;font-size:13px;text-transform:uppercase;letter-spacing:.08em;">
          ${organizationName}
        </p>

        <h1 style="margin:0 0 16px;font-size:28px;line-height:1.15;color:#ffffff;">
          Resend is gekoppeld 🚀
        </h1>

        <p style="margin:0;color:#d8d8df;font-size:16px;line-height:1.6;">
          Hoi ${name},<br/>
          Deze testmail is server-side verzonden vanuit je Supabase Edge Function.
          Je API-key staat dus niet in de browser.
        </p>

        <p style="margin:24px 0 0;color:#9b9ba7;font-size:13px;line-height:1.5;">
          Je kunt deze basis nu gebruiken voor offerte-mails, factuur-mails,
          uitnodigingen en notificaties.
        </p>
      </div>
    </div>
  </body>
</html>`;
}

function buildTestEmailText(input: {
  organizationName: string;
  recipientName: string;
}): string {
  return [
    input.organizationName,
    'Resend is gekoppeld',
    '',
    `Hoi ${input.recipientName || 'Gerjan'},`,
    'Deze testmail is server-side verzonden vanuit je Supabase Edge Function.',
    'Je API-key staat dus niet in de browser.',
    '',
    'Je kunt deze basis nu gebruiken voor offerte-mails, factuur-mails, uitnodigingen en notificaties.',
  ].join('\n');
}

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get('origin') || '';

  const allowOrigin =
    MAIL_ALLOWED_ORIGINS.includes(origin) ||
    (MAIL_ALLOW_LOCAL_DEV && isLocalOrigin(origin))
      ? origin
      : MAIL_ALLOW_LOCAL_DEV && !origin
        ? '*'
        : 'null';

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function json(req: Request, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders(req),
      'Content-Type': 'application/json',
    },
  });
}

function assertAllowedOrigin(req: Request): void {
  const origin = req.headers.get('origin') || '';

  if (!origin && MAIL_ALLOW_LOCAL_DEV) {
    return;
  }

  if (MAIL_ALLOWED_ORIGINS.includes(origin)) {
    return;
  }

  if (MAIL_ALLOW_LOCAL_DEV && isLocalOrigin(origin)) {
    return;
  }

  if (MAIL_ALLOWED_ORIGINS.length === 0 && MAIL_ALLOW_LOCAL_DEV) {
    return;
  }

  if (MAIL_ALLOWED_ORIGINS.length === 0) {
    throw new MailHttpError(
      'MAIL_ALLOWED_ORIGINS of QUOTE_ALLOWED_ORIGINS is verplicht in productie.',
      500,
    );
  }

  throw new MailHttpError(
    'Deze frontend-origin is niet toegestaan voor mailacties.',
    403,
  );
}

async function requireUser(
  req: Request,
): Promise<{ id: string; email?: string }> {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');

  if (!token) {
    throw new MailHttpError(
      'Niet ingelogd: Authorization header ontbreekt.',
      401,
    );
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !data.user) {
    throw new MailHttpError(
      'Niet ingelogd of ongeldig sessietoken.',
      401,
    );
  }

  return {
    id: data.user.id,
    email: data.user.email || undefined,
  };
}

async function requireOrganizationAccess(
  userId: string,
  organizationId: string,
): Promise<OrganizationRole> {
  if (!isUuid(organizationId)) {
    throw new MailHttpError('Ongeldige organisatie.', 400);
  }

  const { data, error } = await supabaseAdmin
    .from('organization_members')
    .select('role')
    .eq('organization_id', organizationId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .limit(1);

  if (error) {
    throw error;
  }

  const role = data?.[0]?.role as OrganizationRole | undefined;

  if (!role) {
    throw new MailHttpError(
      'Geen toegang tot deze organisatie.',
      403,
    );
  }

  return role;
}

function isLocalOrigin(origin: string): boolean {
  return [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ].includes(origin);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => {
    const replacements: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    };

    return replacements[char] || char;
  });
}

function sanitizeIdempotencyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128) || 'unknown';
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);

  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}