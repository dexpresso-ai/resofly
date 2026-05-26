import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
const MOLLIE_ALLOW_MOCK = (Deno.env.get('MOLLIE_ALLOW_MOCK') || 'false').toLowerCase() === 'true';

const allowedOrigins = parseAllowedOrigins([
  Deno.env.get('INVOICE_PUBLIC_ALLOWED_ORIGINS'),
  Deno.env.get('INVOICE_ALLOWED_ORIGINS'),
  Deno.env.get('APP_PUBLIC_URL'),
  Deno.env.get('INVOICE_PUBLIC_BASE_URL'),
]);

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

class PublicInvoiceError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
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

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || 'getInvoice');
    const token = String(body.token || '').trim();

    if (!token) {
      throw new PublicInvoiceError('Factuurlink ontbreekt.', 400);
    }

    if (action !== 'getInvoice' && action !== 'markMockInvoicePaymentPaid') {
      throw new PublicInvoiceError(`Onbekende actie: ${action}`, 400);
    }

    const result = await getInvoice(token, {
      mockPaymentId: String(body.mockPaymentId || body.mock_payment || '').trim(),
      markMockOnly: action === 'markMockInvoicePaymentPaid',
    });

    return json(req, {
      ok: true,
      ...result,
    });
  } catch (error) {
    const status = error instanceof PublicInvoiceError ? error.status : 500;
    const message =
      error instanceof PublicInvoiceError
        ? error.message
        : 'Publieke factuur kon niet worden geladen.';

    if (status >= 500) {
      console.error('invoice-public error', error instanceof Error ? error.message : error);
    }

    return json(req, { ok: false, error: message }, status);
  }
});

async function getInvoice(token: string, options: { mockPaymentId?: string; markMockOnly?: boolean } = {}) {
  const tokenHash = await sha256Hex(token);
  let invoiceRow = await loadInvoiceByTokenHash(tokenHash);

  if (options.mockPaymentId) {
    await maybeMarkMockPaymentPaid(invoiceRow, options.mockPaymentId);
    invoiceRow = await loadInvoiceByTokenHash(tokenHash);
  }

  if (options.markMockOnly) {
    return { invoice: sanitizeInvoice(invoiceRow) };
  }

  const [clientRow, projectRow, quoteRow, companyRow, events, payments, versions] = await Promise.all([
    invoiceRow.client_id ? optionalOne('clients', invoiceRow.organization_id, invoiceRow.client_id) : Promise.resolve(null),
    invoiceRow.project_id ? optionalOne('projects', invoiceRow.organization_id, invoiceRow.project_id) : Promise.resolve(null),
    invoiceRow.quote_id ? optionalOne('quotes', invoiceRow.organization_id, invoiceRow.quote_id) : Promise.resolve(null),
    optionalCompany(invoiceRow.organization_id),
    optionalList('invoice_workflow_events', async () => {
      const { data, error } = await supabaseAdmin
        .from('invoice_workflow_events')
        .select('*')
        .eq('organization_id', invoiceRow.organization_id)
        .eq('invoice_id', invoiceRow.id)
        .order('created_at', { ascending: false })
        .limit(20);

      if (error) throw error;
      return data || [];
    }),
    optionalList('invoice_payment_records', async () => {
      const { data, error } = await supabaseAdmin
        .from('invoice_payment_records')
        .select('*')
        .eq('organization_id', invoiceRow.organization_id)
        .eq('invoice_id', invoiceRow.id)
        .order('created_at', { ascending: false })
        .limit(5);

      if (error) throw error;
      return data || [];
    }),
    optionalList('invoice_versions', async () => {
      const { data, error } = await supabaseAdmin
        .from('invoice_versions')
        .select('*')
        .eq('organization_id', invoiceRow.organization_id)
        .eq('invoice_id', invoiceRow.id)
        .order('version_number', { ascending: false })
        .limit(5);

      if (error) throw error;
      return data || [];
    }),
  ]);

  await logInvoiceViewed(invoiceRow.organization_id, invoiceRow.id);

  return {
    invoice: sanitizeInvoice(invoiceRow),
    client: sanitizeClient(clientRow),
    project: sanitizeProject(projectRow),
    quote: sanitizeQuote(quoteRow),
    company: sanitizeCompany(companyRow),
    events: events.map(sanitizeEvent),
    payments: payments.map(sanitizePayment),
    versions: versions.map(sanitizeVersion),
  };
}

async function loadInvoiceByTokenHash(tokenHash: string) {
  const { data: invoiceRow, error: invoiceError } = await supabaseAdmin
    .from('invoices')
    .select('*')
    .eq('public_token_hash', tokenHash)
    .maybeSingle();

  if (invoiceError) {
    throw invoiceError;
  }

  if (!invoiceRow) {
    throw new PublicInvoiceError('Deze factuurlink is ongeldig of verlopen.', 404);
  }

  if (
    invoiceRow.public_token_expires_at &&
    new Date(invoiceRow.public_token_expires_at).getTime() < Date.now()
  ) {
    throw new PublicInvoiceError('Deze factuurlink is verlopen.', 410);
  }

  if (invoiceRow.status === 'cancelled') {
    throw new PublicInvoiceError('Deze factuur is geannuleerd.', 410);
  }

  return invoiceRow;
}

async function maybeMarkMockPaymentPaid(invoiceRow: any, providerPaymentId: string) {
  if (!providerPaymentId) return;
  if (!providerPaymentId.startsWith('mock_invoice_payment_')) return;

  if (!MOLLIE_ALLOW_MOCK) {
    throw new PublicInvoiceError('Mock-betalingen zijn uitgeschakeld.', 403);
  }

  const { data: payment, error: paymentLookupError } = await supabaseAdmin
    .from('invoice_payment_records')
    .select('id,organization_id,invoice_id,provider_payment_id,status')
    .eq('organization_id', invoiceRow.organization_id)
    .eq('invoice_id', invoiceRow.id)
    .eq('provider', 'mollie')
    .eq('provider_payment_id', providerPaymentId)
    .maybeSingle();

  if (paymentLookupError) throw paymentLookupError;
  if (!payment) throw new PublicInvoiceError('Mock-betaalrecord niet gevonden voor deze factuur.', 404);
  if (payment.status === 'paid') return;

  const { error } = await supabaseAdmin.rpc('update_invoice_payment_status', {
    p_provider_payment_id: providerPaymentId,
    p_status: 'paid',
    p_paid_at: new Date().toISOString(),
    p_metadata: { mock: true, source: 'public_invoice_page' },
  });

  if (error) throw error;
}

async function optionalOne(tableName: string, organizationId: string, id: string) {
  try {
    const { data, error } = await supabaseAdmin
      .from(tableName)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) {
      console.warn(`invoice-public optional lookup failed: ${tableName}`, error.message);
      return null;
    }

    return data || null;
  } catch (error) {
    console.warn(
      `invoice-public optional lookup crashed: ${tableName}`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

async function optionalCompany(organizationId: string) {
  try {
    const { data, error } = await supabaseAdmin
      .from('company_settings')
      .select('*')
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) {
      console.warn('invoice-public company lookup failed', error.message);
      return null;
    }

    return data || null;
  } catch (error) {
    console.warn(
      'invoice-public company lookup crashed',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

async function optionalList(name: string, loader: () => Promise<any[]>) {
  try {
    return await loader();
  } catch (error) {
    console.warn(
      `invoice-public optional list failed: ${name}`,
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

async function logInvoiceViewed(organizationId: string, invoiceId: string) {
  try {
    const { error } = await supabaseAdmin.rpc('insert_invoice_workflow_event', {
      p_organization_id: organizationId,
      p_invoice_id: invoiceId,
      p_event_type: 'client_viewed',
      p_title: 'Factuur bekeken',
      p_description: 'Publieke factuurpagina is geopend.',
      p_metadata: {},
      p_actor_user_id: null,
    });

    if (error) console.warn('invoice-public view event insert failed', error.message);
  } catch (error) {
    console.warn(
      'invoice-public view event insert crashed',
      error instanceof Error ? error.message : error,
    );
  }
}

function sanitizeInvoice(row: any) {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    date: row.date,
    due_date: row.due_date,
    sent_at: row.sent_at,
    paid_at: row.paid_at,
    client_id: row.client_id,
    project_id: row.project_id,
    quote_id: row.quote_id,
    lines: row.lines || [],
    notes: row.notes,
    subtotal: row.subtotal,
    tax_amount: row.tax_amount,
    total_amount: row.total_amount,
    total_excl_vat: row.total_excl_vat,
    total_vat: row.total_vat,
    total_incl_vat: row.total_incl_vat,
    currency: row.currency || 'EUR',
    public_token_created_at: row.public_token_created_at,
    public_token_expires_at: row.public_token_expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function sanitizeClient(row: any) {
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    contact_name: row.contact_name,
    email: row.email,
    phone: row.phone,
    address: row.address,
    postal_code: row.postal_code,
    city: row.city,
    country: row.country,
    vat_number: row.vat_number,
    chamber_of_commerce: row.chamber_of_commerce,
  };
}

function sanitizeProject(row: any) {
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    start_date: row.start_date,
    end_date: row.end_date,
  };
}

function sanitizeQuote(row: any) {
  if (!row) return null;

  return {
    id: row.id,
    number: row.number,
    status: row.status,
    date: row.date,
    total_amount: row.total_amount,
  };
}

function sanitizeCompany(row: any) {
  if (!row) return null;

  return {
    company_name: row.company_name,
    trade_name: row.trade_name,
    email: row.email,
    phone: row.phone,
    website: row.website,
    address: row.address,
    postal_code: row.postal_code,
    city: row.city,
    country: row.country,
    iban: row.iban,
    vat_number: row.vat_number,
    chamber_of_commerce: row.chamber_of_commerce,
    invoice_payment_terms: row.invoice_payment_terms,
    invoice_footer: row.invoice_footer,
  };
}

function sanitizeEvent(row: any) {
  return {
    id: row.id,
    event_type: row.event_type,
    title: row.title,
    description: row.description,
    metadata: row.metadata,
    created_at: row.created_at,
  };
}

function sanitizePayment(row: any) {
  return {
    id: row.id,
    status: row.status,
    amount_cents: row.amount_cents,
    currency: row.currency || 'EUR',
    provider: row.provider,
    provider_payment_id: row.provider_payment_id,
    provider_checkout_url: row.provider_checkout_url,
    checkout_expires_at: row.checkout_expires_at,
    paid_at: row.paid_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function sanitizeVersion(row: any) {
  return {
    id: row.id,
    version_number: row.version_number,
    snapshot_reason: row.snapshot_reason,
    pdf_file_name: row.pdf_file_name,
    pdf_mime_type: row.pdf_mime_type,
    pdf_size_bytes: row.pdf_size_bytes,
    pdf_sha256: row.pdf_sha256,
    total_amount: row.total_amount,
    created_at: row.created_at,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function parseAllowedOrigins(values: Array<string | null>): string[] {
  const origins = new Set<string>();

  for (const value of values) {
    if (!value) continue;

    for (const rawPart of value.split(',')) {
      const part = rawPart.trim().replace(/\/$/, '');
      if (!part) continue;

      try {
        origins.add(new URL(part).origin);
      } catch {
        origins.add(part);
      }
    }
  }

  return Array.from(origins);
}

function assertAllowedOrigin(req: Request) {
  const origin = req.headers.get('origin') || '';

  if (!origin) return;
  if (allowedOrigins.includes(origin)) return;

  throw new PublicInvoiceError(
    'Deze frontend-origin is niet toegestaan voor publieke factuurpagina.',
    403,
  );
}

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get('origin') || '';
  const allowOrigin = allowedOrigins.includes(origin) ? origin : '*';

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);

  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}
