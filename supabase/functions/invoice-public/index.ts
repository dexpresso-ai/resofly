import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
const MOLLIE_ALLOW_MOCK = (Deno.env.get('MOLLIE_ALLOW_MOCK') || 'false').toLowerCase() === 'true';
const INVOICE_PDF_STORAGE_WORKER_URL = (Deno.env.get('INVOICE_PDF_STORAGE_WORKER_URL') || '').replace(/\/$/, '');
const INVOICE_PDF_STORAGE_SECRET = Deno.env.get('INVOICE_PDF_STORAGE_SECRET') || '';

const allowedOrigins = parseAllowedOrigins([
  Deno.env.get('INVOICE_PUBLIC_ALLOWED_ORIGINS'),
  Deno.env.get('INVOICE_ALLOWED_ORIGINS'),
  Deno.env.get('APP_PUBLIC_URL'),
  Deno.env.get('INVOICE_PUBLIC_BASE_URL'),
]);

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

class PublicInvoiceError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Geef een leesbare omschrijving van een willekeurige fout. Supabase/Postgres
 * geven errors terug als plain objects (geen Error-instance) met velden zoals
 * `message`, `code`, `details`, `hint`. `String(error)` op zo'n object geeft
 * "[object Object]" — daarom unpacken we de bekende velden expliciet.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || 'Error';
  if (error && typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof obj.message === 'string' && obj.message) parts.push(obj.message);
    if (typeof obj.code === 'string' && obj.code) parts.push(`(code ${obj.code})`);
    if (typeof obj.details === 'string' && obj.details) parts.push(`details: ${obj.details}`);
    if (typeof obj.hint === 'string' && obj.hint) parts.push(`hint: ${obj.hint}`);
    if (parts.length) return parts.join(' ');
    try { return JSON.stringify(obj); } catch { /* val terug op String() */ }
  }
  return String(error);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return json(req, { ok: true });

  try {
    assertAllowedOrigin(req);
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Method not allowed.' }, 405);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || 'getInvoice');
    const token = String(body.token || '').trim();
    const mockPaymentId = String(body.mockPaymentId || body.mock_payment || '').trim();

    if (!token) throw new PublicInvoiceError('Factuurlink ontbreekt.', 400);
    if (action === 'getInvoicePdf') {
      return json(req, { ok: true, ...(await getInvoicePdf(token)) });
    }
    if (action !== 'getInvoice' && action !== 'markMockInvoicePaymentPaid') {
      throw new PublicInvoiceError(`Onbekende actie: ${action}`, 400);
    }

    const result = await getInvoice(token, {
      mockPaymentId,
      markMockOnly: action === 'markMockInvoicePaymentPaid',
    });

    return json(req, { ok: true, ...result });
  } catch (error) {
    const status = error instanceof PublicInvoiceError ? error.status : 500;
    let message: string;
    if (error instanceof PublicInvoiceError) {
      message = error.message;
    } else {
      // Bewust de werkelijke foutreden teruggeven (afgekapt op 500 chars) zodat de
      // publieke factuurpagina diagnostisch is zonder dat de Supabase functie-logs
      // geopend hoeven worden. Supabase/Postgres-foutmeldingen bevatten doorgaans
      // veldnamen en constraint-namen, geen secrets, dus dit is veilig.
      message = `Publieke factuur kon niet worden geladen: ${describeError(error)}`.slice(0, 500);
    }
    if (status >= 500) {
      console.error('invoice-public error', describeError(error), error instanceof Error ? error.stack : undefined);
    }
    return json(req, { ok: false, error: message }, status);
  }
});

async function getInvoice(token: string, options: { mockPaymentId?: string; markMockOnly?: boolean } = {}) {
  const link = await resolvePublicLink(token);
  let invoiceRow = await loadInvoice(link.organization_id, link.invoice_id);
  let mockPaymentWarning: string | null = null;

  if (options.mockPaymentId) {
    try {
      await maybeMarkMockPaymentPaid(invoiceRow, options.mockPaymentId);
      invoiceRow = await loadInvoice(link.organization_id, link.invoice_id);
    } catch (markError) {
      // Markeren als betaald is een neveneffect bij het terugkomen van de mock-
      // checkout. Een storing daar mag de hele factuurweergave niet platleggen —
      // de factuur is gewoon zichtbaar, alleen de status volgt later via webhook.
      const detail = markError instanceof PublicInvoiceError ? markError.message : describeError(markError);
      console.warn('invoice-public mock payment mark failed', detail);
      mockPaymentWarning = `Mock-betaling kon niet automatisch worden gemarkeerd als betaald: ${detail}`.slice(0, 400);
    }
  }

  if (options.markMockOnly) return { invoice: sanitizeInvoice(invoiceRow, link), mockPaymentWarning };

  const [clientRow, projectRow, quoteRow, companyRow, events, payments, versions] = await Promise.all([
    invoiceRow.client_id ? optionalOne('clients', invoiceRow.organization_id, invoiceRow.client_id) : Promise.resolve(null),
    invoiceRow.project_id ? optionalOne('projects', invoiceRow.organization_id, invoiceRow.project_id) : Promise.resolve(null),
    invoiceRow.quote_id ? optionalOne('quotes', invoiceRow.organization_id, invoiceRow.quote_id) : Promise.resolve(null),
    optionalCompany(invoiceRow.organization_id),
    optionalList('invoice_workflow_events', async () => {
      const { data, error } = await supabaseAdmin
        .from('invoice_workflow_events')
        .select('event_type,title,description,created_at')
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
        .select('status,amount_cents,currency,provider_checkout_url,checkout_expires_at,paid_at,created_at')
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
        .select('version_number,snapshot_reason,pdf_file_name,pdf_mime_type,pdf_size_bytes,pdf_sha256,created_at,total_amount')
        .eq('organization_id', invoiceRow.organization_id)
        .eq('invoice_id', invoiceRow.id)
        .order('version_number', { ascending: false })
        .limit(5);
      if (error) throw error;
      return data || [];
    }),
  ]);

  await logInvoiceViewed(invoiceRow.organization_id, invoiceRow.id, link.link_id);

  return {
    invoice: sanitizeInvoice(invoiceRow, link),
    client: sanitizeClient(clientRow),
    project: sanitizeProject(projectRow),
    quote: sanitizeQuote(quoteRow),
    company: sanitizeCompany(companyRow),
    events: events.map(sanitizeEvent),
    payments: payments.map(sanitizePayment),
    versions: versions.map(sanitizeVersion),
    mockPaymentWarning,
  };
}


async function getInvoicePdf(token: string) {
  const link = await resolvePublicLink(token);
  const invoiceRow = await loadInvoice(link.organization_id, link.invoice_id);

  const { data: versions, error } = await supabaseAdmin
    .from('invoice_versions')
    .select('snapshot_reason,pdf_file_name,pdf_mime_type,pdf_size_bytes,pdf_sha256,pdf_data_base64,pdf_storage_provider,pdf_storage_key,created_at,version_number')
    .eq('organization_id', invoiceRow.organization_id)
    .eq('invoice_id', invoiceRow.id)
    .not('pdf_file_name', 'is', null)
    .order('version_number', { ascending: false })
    .limit(20);

  if (error) throw error;

  const usableVersions = (versions || []).filter((candidate: any) => {
    const hasDatabasePdf = Boolean(String(candidate.pdf_data_base64 || '').trim());
    const hasPrivateStoragePdf = candidate.pdf_storage_provider === 'r2' && Boolean(candidate.pdf_storage_key);
    return hasDatabasePdf || hasPrivateStoragePdf;
  });

  const version =
    usableVersions.find((candidate: any) => candidate.snapshot_reason === 'sent_to_client') ||
    usableVersions[0];

  if (!version) {
    throw new PublicInvoiceError('Er is nog geen beschikbare PDF-snapshot voor deze factuur.', 404);
  }

  let base64 = String(version.pdf_data_base64 || '').trim();

  if (!base64 && version.pdf_storage_provider === 'r2' && version.pdf_storage_key) {
    if (!INVOICE_PDF_STORAGE_WORKER_URL || !INVOICE_PDF_STORAGE_SECRET) {
      throw new PublicInvoiceError('PDF-snapshot is opgeslagen in private storage, maar de storage-koppeling ontbreekt.', 500);
    }

    const response = await fetch(`${INVOICE_PDF_STORAGE_WORKER_URL}/internal/invoice-snapshot/${encodeURIComponent(version.pdf_storage_key)}`, {
      headers: { Authorization: `Bearer ${INVOICE_PDF_STORAGE_SECRET}` },
    });

    if (!response.ok) {
      throw new PublicInvoiceError('PDF-snapshot kon niet uit private storage worden opgehaald.', 502);
    }

    base64 = arrayBufferToBase64(await response.arrayBuffer());
  }

  if (!base64) throw new PublicInvoiceError('PDF-snapshot ontbreekt of is niet beschikbaar.', 404);

  return {
    pdf: {
      fileName: version.pdf_file_name || `factuur-${invoiceRow.number}.pdf`,
      mimeType: version.pdf_mime_type || 'application/pdf',
      sizeBytes: version.pdf_size_bytes || null,
      sha256: version.pdf_sha256 || null,
      base64,
    },
  };
}

async function resolvePublicLink(token: string): Promise<{ link_id: string | null; organization_id: string; invoice_id: string; purpose: string; expires_at: string | null }> {
  const { data, error } = await supabaseAdmin.rpc('resolve_invoice_public_link', {
    p_token: token,
    p_touch: true,
  });
  if (error) throw error;
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  const row = rows[0];
  if (!row?.invoice_id || !row?.organization_id) {
    throw new PublicInvoiceError('Deze factuurlink is ongeldig of verlopen.', 404);
  }
  return row;
}

async function loadInvoice(organizationId: string, invoiceId: string) {
  const { data, error } = await supabaseAdmin
    .from('invoices')
    .select('*')
    .eq('id', invoiceId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new PublicInvoiceError('Factuur niet gevonden.', 404);
  if (data.status === 'cancelled' || data.status === 'void') throw new PublicInvoiceError('Deze factuur is geannuleerd.', 410);
  return data;
}

async function maybeMarkMockPaymentPaid(invoiceRow: any, providerPaymentId: string) {
  if (!providerPaymentId) return;
  if (!providerPaymentId.startsWith('mock_invoice_payment_')) return;
  if (!MOLLIE_ALLOW_MOCK) throw new PublicInvoiceError('Mock-betalingen zijn uitgeschakeld.', 403);

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
    console.warn(`invoice-public optional lookup crashed: ${tableName}`, error instanceof Error ? error.message : error);
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
    console.warn('invoice-public company lookup crashed', error instanceof Error ? error.message : error);
    return null;
  }
}

async function optionalList(name: string, loader: () => Promise<any[]>) {
  try {
    return await loader();
  } catch (error) {
    console.warn(`invoice-public optional list failed: ${name}`, error instanceof Error ? error.message : error);
    return [];
  }
}

async function logInvoiceViewed(organizationId: string, invoiceId: string, publicLinkId: string | null) {
  try {
    const { error } = await supabaseAdmin.rpc('insert_invoice_workflow_event', {
      p_organization_id: organizationId,
      p_invoice_id: invoiceId,
      p_event_type: 'client_viewed',
      p_title: 'Factuur bekeken',
      p_description: 'Publieke factuurpagina is geopend.',
      p_metadata: { public_link_id: publicLinkId },
      p_actor_user_id: null,
    });
    if (error) console.warn('invoice-public view event insert failed', error.message);
  } catch (error) {
    console.warn('invoice-public view event insert crashed', error instanceof Error ? error.message : error);
  }
}

function sanitizeInvoice(row: any, link: { expires_at?: string | null }) {
  return {
    number: row.number,
    status: row.status,
    date: row.date,
    due_date: row.due_date,
    sent_at: row.sent_at,
    paid_at: row.paid_at,
    lines: Array.isArray(row.lines) ? row.lines : [],
    notes: row.notes,
    subtotal_amount: row.subtotal_amount,
    vat_amount: row.vat_amount,
    total_amount: row.total_amount,
    currency: row.currency || 'EUR',
    public_token_expires_at: link.expires_at || row.public_token_expires_at || null,
  };
}

function sanitizeClient(row: any) {
  if (!row) return null;
  return {
    name: row.name,
    contact_name: row.contact_name,
    email: row.email,
    phone: row.phone,
    address: row.address,
    postal_code: row.postal_code,
    city: row.city,
    country: row.country,
  };
}

function sanitizeProject(row: any) {
  if (!row) return null;
  return { name: row.name, description: row.description, status: row.status, start_date: row.start_date, end_date: row.end_date };
}

function sanitizeQuote(row: any) {
  if (!row) return null;
  return { number: row.number, status: row.status, date: row.date, total_amount: row.total_amount };
}

function sanitizeCompany(row: any) {
  if (!row) return null;
  return {
    company_name: row.company_name,
    trade_name: row.trade_name,
    email: row.email,
    phone: row.phone,
    website: row.website,
    address: row.address || row.address_line1,
    postal_code: row.postal_code,
    city: row.city,
    country: row.country,
    iban: row.iban,
    vat_number: row.vat_number,
    kvk_number: row.kvk_number || row.chamber_of_commerce,
    invoice_payment_terms: row.invoice_payment_terms,
    invoice_footer: row.invoice_footer,
  };
}

function sanitizeEvent(row: any) {
  return {
    event_type: row.event_type,
    title: row.title,
    description: row.description,
    created_at: row.created_at,
  };
}

function sanitizePayment(row: any) {
  return {
    status: row.status,
    amount_cents: row.amount_cents,
    currency: row.currency || 'EUR',
    checkout_url: row.provider_checkout_url,
    checkout_expires_at: row.checkout_expires_at,
    paid_at: row.paid_at,
    created_at: row.created_at,
  };
}

function sanitizeVersion(row: any) {
  return {
    version_number: row.version_number,
    snapshot_reason: row.snapshot_reason,
    pdf_file_name: row.pdf_file_name,
    pdf_mime_type: row.pdf_mime_type,
    pdf_size_bytes: row.pdf_size_bytes,
    pdf_sha256: row.pdf_sha256,
    created_at: row.created_at,
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function parseAllowedOrigins(values: Array<string | null>): string[] {
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
  throw new PublicInvoiceError('Deze frontend-origin is niet toegestaan voor publieke factuurpagina.', 403);
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
  return new Response(JSON.stringify(payload), { status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } });
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
