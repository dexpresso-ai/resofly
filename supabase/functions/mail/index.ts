import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { renderEmailTemplate } from '../_shared/emailTemplates/index.ts';

type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer';
type MailHttpErrorStatus = 400 | 401 | 403 | 404 | 422 | 500 | 502;

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
const RESEND_FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || '';
const RESEND_REPLY_TO = Deno.env.get('RESEND_REPLY_TO') || '';
const MAIL_ALLOWED_ORIGINS = (
  Deno.env.get('MAIL_ALLOWED_ORIGINS') ||
  Deno.env.get('QUOTE_ALLOWED_ORIGINS') ||
  Deno.env.get('BILLING_ALLOWED_RETURN_ORIGINS') ||
  ''
)
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const MAIL_ALLOW_LOCAL_DEV = (Deno.env.get('MAIL_ALLOW_LOCAL_DEV') || 'false').toLowerCase() === 'true';

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
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
  if (req.method === 'OPTIONS') return json(req, { ok: true });
  try {
    assertAllowedOrigin(req);
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Method not allowed.' }, 405);

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(body.action || '');
    const organizationId = String(body.organizationId || '');
    const user = await requireUser(req);
    const role = await requireOrganizationAccess(user.id, organizationId);

    switch (action) {
      case 'sendTestEmail': {
        if (!['owner', 'admin'].includes(role)) {
          throw new MailHttpError('Alleen owners en admins kunnen Resend-testmails verzenden.', 403);
        }
        return json(req, { ok: true, ...(await sendTestEmail(user.id, organizationId, body)) });
      }
      default:
        return json(req, { ok: false, error: `Onbekende mail action: ${action}` }, 400);
    }
  } catch (error) {
    const status = error instanceof MailHttpError ? error.status : 500;
    const internalMessage = error instanceof Error ? error.message : 'Onbekende fout.';
    if (status >= 500) console.error('mail function error', internalMessage);
    const publicMessage = error instanceof MailHttpError
      ? error.message
      : 'Mailactie mislukt door een server- of providerfout. Controleer de Edge Function logs.';
    return json(req, { ok: false, error: publicMessage }, status);
  }
});

async function sendTestEmail(userId: string, organizationId: string, body: Record<string, unknown>) {
  if (!RESEND_API_KEY) throw new MailHttpError('RESEND_API_KEY ontbreekt in de Edge Function secrets.', 500);
  if (!RESEND_FROM_EMAIL) throw new MailHttpError('RESEND_FROM_EMAIL ontbreekt in de Edge Function secrets.', 500);

  const recipientEmail = String(body.recipientEmail || '').trim().toLowerCase();
  const recipientName = String(body.recipientName || '').trim();
  if (!isEmail(recipientEmail)) throw new MailHttpError('Vul een geldig e-mailadres in voor de testmail.', 422);

  const organization = await loadOrganization(organizationId);
  const company = await loadCompanySettings(organizationId);
  const organizationName = company?.trade_name || company?.company_name || organization.name || 'ResoFly';
  const email = renderEmailTemplate('test.resend', { organizationName, recipientName });

  const resendPayload = await sendViaResend({
    from: RESEND_FROM_EMAIL,
    to: [recipientEmail],
    reply_to: RESEND_REPLY_TO || undefined,
    subject: email.subject,
    html: email.html,
    text: email.text,
    tags: [
      { name: 'organization_id', value: sanitizeTagValue(organizationId) },
      { name: 'template_key', value: email.templateKey },
      { name: 'purpose', value: 'resend_test' },
      { name: 'actor_user_id', value: sanitizeTagValue(userId) },
    ],
  }, `mail-test-${organizationId}-${crypto.randomUUID()}`);

  const providerEmailId = String(resendPayload.id || resendPayload.email_id || '').trim();
  if (!providerEmailId) {
    throw new MailHttpError('Resend heeft de testmail aangenomen, maar gaf geen e-mail-ID terug.', 502);
  }

  return { providerEmailId, recipientEmail };
}

async function sendViaResend(payload: Record<string, unknown>, idempotencyKey: string): Promise<Record<string, unknown>> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey.slice(0, 256),
    },
    body: JSON.stringify(payload),
  });

  const responsePayload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    console.error('Resend testmail failed', responsePayload);
    const providerMessage = String(responsePayload.message || responsePayload.error || response.statusText || 'Resend send failed');
    throw new MailHttpError(`Resend kon de testmail niet versturen: ${providerMessage}`, 502);
  }
  return responsePayload;
}

async function loadOrganization(organizationId: string): Promise<{ id: string; name: string }> {
  if (!isUuid(organizationId)) throw new MailHttpError('Ongeldige organisatie.', 400);
  const { data, error } = await supabaseAdmin
    .from('organizations')
    .select('id,name')
    .eq('id', organizationId)
    .single();
  if (error || !data) throw new MailHttpError('Organisatie niet gevonden.', 404);
  return data as { id: string; name: string };
}

async function loadCompanySettings(organizationId: string): Promise<{ company_name: string; trade_name: string | null } | null> {
  const { data, error } = await supabaseAdmin
    .from('company_settings')
    .select('company_name,trade_name')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as { company_name: string; trade_name: string | null } | null;
}


function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get('origin') || '';
  const allowOrigin = MAIL_ALLOWED_ORIGINS.includes(origin) || (MAIL_ALLOW_LOCAL_DEV && isLocalOrigin(origin))
    ? origin
    : (MAIL_ALLOW_LOCAL_DEV && !origin ? '*' : 'null');
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

function json(req: Request, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  });
}

function assertAllowedOrigin(req: Request): void {
  const origin = req.headers.get('origin') || '';
  if (!origin && MAIL_ALLOW_LOCAL_DEV) return;
  if (MAIL_ALLOWED_ORIGINS.includes(origin)) return;
  if (MAIL_ALLOW_LOCAL_DEV && isLocalOrigin(origin)) return;
  if (MAIL_ALLOWED_ORIGINS.length === 0 && MAIL_ALLOW_LOCAL_DEV) return;
  if (MAIL_ALLOWED_ORIGINS.length === 0) throw new MailHttpError('MAIL_ALLOWED_ORIGINS of QUOTE_ALLOWED_ORIGINS is verplicht in productie.', 500);
  throw new MailHttpError('Deze frontend-origin is niet toegestaan voor mailacties.', 403);
}

async function requireUser(req: Request): Promise<{ id: string; email?: string }> {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) throw new MailHttpError('Niet ingelogd: Authorization header ontbreekt.', 401);
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) throw new MailHttpError('Niet ingelogd of ongeldig sessietoken.', 401);
  return { id: data.user.id, email: data.user.email || undefined };
}

async function requireOrganizationAccess(userId: string, organizationId: string): Promise<OrganizationRole> {
  if (!isUuid(organizationId)) throw new MailHttpError('Ongeldige organisatie.', 400);
  const { data, error } = await supabaseAdmin
    .from('organization_members')
    .select('role')
    .eq('organization_id', organizationId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .limit(1);
  if (error) throw error;
  const role = data?.[0]?.role as OrganizationRole | undefined;
  if (!role) throw new MailHttpError('Geen toegang tot deze organisatie.', 403);
  return role;
}

function isLocalOrigin(origin: string): boolean {
  return ['http://localhost:5173', 'http://127.0.0.1:5173'].includes(origin);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}


function sanitizeTagValue(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 256) || 'unknown';
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
