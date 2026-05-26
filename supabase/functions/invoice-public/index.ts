import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
const INVOICE_PUBLIC_ALLOWED_ORIGINS = parseAllowedOrigins([
  Deno.env.get('INVOICE_PUBLIC_ALLOWED_ORIGINS'),
  Deno.env.get('INVOICE_ALLOWED_ORIGINS'),
  Deno.env.get('APP_PUBLIC_URL'),
  Deno.env.get('INVOICE_PUBLIC_BASE_URL'),
]);
const INVOICE_PUBLIC_ALLOW_LOCAL_DEV = (Deno.env.get('INVOICE_PUBLIC_ALLOW_LOCAL_DEV') || Deno.env.get('INVOICE_ALLOW_LOCAL_DEV') || 'false').toLowerCase() === 'true';
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

class PublicInvoiceError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }

serve(async (req) => {
  if (req.method === 'OPTIONS') return json(req, { ok: true });
  try {
    assertAllowedOrigin(req);
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Method not allowed.' }, 405);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');
    const token = String(body.token || '').trim();
    if (!token) throw new PublicInvoiceError('Factuurlink ontbreekt.', 400);
    switch (action) {
      case 'getInvoice': return json(req, { ok: true, ...(await getInvoice(token)) });
      default: return json(req, { ok: false, error: `Onbekende invoice-public action: ${action}` }, 400);
    }
  } catch (error) {
    const status = error instanceof PublicInvoiceError ? error.status : 500;
    const message = error instanceof PublicInvoiceError ? error.message : 'Publieke factuur kon niet worden geladen.';
    if (status >= 500) console.error('invoice-public error', error instanceof Error ? error.message : error);
    return json(req, { ok: false, error: message }, status);
  }
});

async function getInvoice(token: string) {
  const tokenHash = await sha256Hex(token);
  const { data: invoice, error } = await supabaseAdmin
    .from('invoices')
    .select('*')
    .eq('public_token_hash', tokenHash)
    .maybeSingle();
  if (error) throw error;
  if (!invoice) throw new PublicInvoiceError('Deze factuurlink is ongeldig of verlopen.', 404);
  if (invoice.public_token_expires_at && new Date(invoice.public_token_expires_at).getTime() < Date.now()) throw new PublicInvoiceError('Deze factuurlink is verlopen.', 410);
  if (invoice.status === 'cancelled') throw new PublicInvoiceError('Deze factuur is geannuleerd.', 410);

  const [client, project, quote, events, payments, versions] = await Promise.all([
    invoice.client_id ? selectOne('clients', invoice.organization_id, invoice.client_id, 'name,contact_name,email,phone') : Promise.resolve(null),
    invoice.project_id ? selectOne('projects', invoice.organization_id, invoice.project_id, 'name,description,start_date,end_date') : Promise.resolve(null),
    invoice.quote_id ? selectOne('quotes', invoice.organization_id, invoice.quote_id, 'number,date') : Promise.resolve(null),
    supabaseAdmin.from('invoice_workflow_events').select('id,event_type,title,description,created_at').eq('organization_id', invoice.organization_id).eq('invoice_id', invoice.id).order('created_at', { ascending: false }).limit(20).then(({ data }) => data ?? []),
    supabaseAdmin.from('invoice_payment_records').select('id,status,provider_checkout_url,amount_cents,currency,paid_at,checkout_expires_at,created_at').eq('organization_id', invoice.organization_id).eq('invoice_id', invoice.id).order('created_at', { ascending: false }).limit(5).then(({ data }) => data ?? []),
    supabaseAdmin.from('invoice_versions').select('id,version_number,pdf_file_name,pdf_mime_type,pdf_size_bytes,pdf_sha256,created_at,snapshot_reason,total_amount').eq('organization_id', invoice.organization_id).eq('invoice_id', invoice.id).order('version_number', { ascending: false }).limit(3).then(({ data }) => data ?? []),
  ]);
  const { data: company } = await supabaseAdmin.from('company_settings').select('company_name,trade_name,email,phone,website,city,country,iban,invoice_payment_terms,invoice_footer').eq('organization_id', invoice.organization_id).maybeSingle();
  await supabaseAdmin.rpc('insert_invoice_workflow_event', { p_organization_id: invoice.organization_id, p_invoice_id: invoice.id, p_event_type: 'client_viewed', p_title: 'Factuur bekeken', p_description: 'Publieke factuurpagina is geopend.', p_metadata: {}, p_actor_user_id: null }).catch(() => undefined);
  const safeInvoice = { ...invoice };
  delete safeInvoice.public_token_hash;
  return { invoice: safeInvoice, client, project, quote, company: company ?? null, events, payments, versions };
}

async function selectOne(table: string, organizationId: string, id: string, columns: string) {
  const { data, error } = await supabaseAdmin.from(table).select(columns).eq('id', id).eq('organization_id', organizationId).maybeSingle();
  if (error) throw error;
  return data ?? null;
}

async function sha256Hex(value: string): Promise<string> { const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }
function parseAllowedOrigins(values: Array<string | null>): string[] { const origins = new Set<string>(); for (const value of values) { if (!value) continue; for (const rawPart of value.split(',')) { const part = rawPart.trim().replace(/\/$/, ''); if (!part) continue; if (part.startsWith('http://') || part.startsWith('https://')) { try { origins.add(new URL(part).origin); } catch { origins.add(part); } } else origins.add(part); } } return [...origins]; }
function corsHeaders(req: Request): HeadersInit { const origin = req.headers.get('origin') || ''; const allowOrigin = INVOICE_PUBLIC_ALLOWED_ORIGINS.includes(origin) || (INVOICE_PUBLIC_ALLOW_LOCAL_DEV && isLocalOrigin(origin)) ? origin : INVOICE_PUBLIC_ALLOW_LOCAL_DEV && !origin ? '*' : 'null'; return { 'Access-Control-Allow-Origin': allowOrigin, 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin' }; }
function json(req: Request, payload: unknown, status = 200): Response { return new Response(JSON.stringify(payload), { status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } }); }
function assertAllowedOrigin(req: Request): void { const origin = req.headers.get('origin') || ''; if (!origin && INVOICE_PUBLIC_ALLOW_LOCAL_DEV) return; if (INVOICE_PUBLIC_ALLOWED_ORIGINS.includes(origin)) return; if (INVOICE_PUBLIC_ALLOW_LOCAL_DEV && isLocalOrigin(origin)) return; if (INVOICE_PUBLIC_ALLOWED_ORIGINS.length === 0 && INVOICE_PUBLIC_ALLOW_LOCAL_DEV) return; if (INVOICE_PUBLIC_ALLOWED_ORIGINS.length === 0) throw new PublicInvoiceError('INVOICE_PUBLIC_ALLOWED_ORIGINS of APP_PUBLIC_URL is verplicht in productie.', 500); throw new PublicInvoiceError('Deze frontend-origin is niet toegestaan voor publieke factuurpagina.', 403); }
function isLocalOrigin(origin: string): boolean { return ['http://localhost:5173', 'http://127.0.0.1:5173'].includes(origin); }
function requiredEnv(name: string): string { const value = Deno.env.get(name); if (!value) throw new Error(`Missing required env var: ${name}`); return value; }
