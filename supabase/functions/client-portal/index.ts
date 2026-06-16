import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

// ============================================================
// ResoFly — Klantportaal (client portal) edge function
//
// Geauthenticeerd eindpunt voor het klantportaal op /portal. De ingelogde klant
// (magische e-maillink via Supabase Auth) krijgt inzage in zijn eigen facturen,
// offertes, tickets en projecten en kan support-tickets aanmaken.
//
// Beveiliging:
// - Authenticatie: Bearer-JWT van de portaalsessie wordt geverifieerd
//   (supabaseAdmin.auth.getUser). De function draait ook met verify_jwt = true.
// - Autorisatie: de toegestane klantdossiers worden UITSLUITEND afgeleid uit het
//   geverifieerde e-mailadres (RPC portal_clients_for_email, service-role only).
//   Een client_id uit de request wordt altijd opnieuw tegen die set gevalideerd.
// - Saneren: alleen klantveilige velden gaan terug (geen interne notities,
//   geen interne offerte-goedkeuringsvelden, geen andere klanten).
// ============================================================

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');

// Falt terug op de gedeelde invoice/quote-opslagconfig zodat één Worker + secret
// de factuur-PDF-download voedt (parity met invoice-public).
const INVOICE_PDF_STORAGE_WORKER_URL = (
  Deno.env.get('INVOICE_PDF_STORAGE_WORKER_URL') ||
  Deno.env.get('QUOTE_PDF_STORAGE_WORKER_URL') ||
  ''
).replace(/\/$/, '');
const INVOICE_PDF_STORAGE_SECRET =
  Deno.env.get('INVOICE_PDF_STORAGE_SECRET') ||
  Deno.env.get('QUOTE_PDF_STORAGE_SECRET') ||
  '';

const allowedOrigins = parseAllowedOrigins([
  Deno.env.get('CLIENT_PORTAL_ALLOWED_ORIGINS'),
  Deno.env.get('APP_PUBLIC_URL'),
  Deno.env.get('INVOICE_PUBLIC_ALLOWED_ORIGINS'),
  Deno.env.get('INVOICE_ALLOWED_ORIGINS'),
  Deno.env.get('QUOTE_PUBLIC_ALLOWED_ORIGINS'),
]);

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

class PortalError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

type ClientRow = {
  id: string;
  organization_id: string;
  name: string;
  client_code: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return json(req, { ok: true });

  try {
    assertAllowedOrigin(req);
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Method not allowed.' }, 405);

    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || 'getPortalData');

    switch (action) {
      case 'getPortalData':
        return json(req, { ok: true, ...(await getPortalData(user)) });
      case 'createTicket':
        return json(req, { ok: true, ...(await createTicket(user, body)) });
      case 'getInvoicePdf':
        return json(req, { ok: true, ...(await getInvoicePdf(user, body)) });
      default:
        throw new PortalError(`Onbekende actie: ${action}`, 400);
    }
  } catch (error) {
    const status = error instanceof PortalError ? error.status : 500;
    const message = error instanceof PortalError
      ? error.message
      : `Klantportaal kon de aanvraag niet verwerken: ${describeError(error)}`.slice(0, 500);
    if (status >= 500) {
      console.error('client-portal error', describeError(error), error instanceof Error ? error.stack : undefined);
    }
    return json(req, { ok: false, error: message }, status);
  }
});

// ── Acties ────────────────────────────────────────────────────────────

async function getPortalData(user: { id: string; email: string }) {
  const clients = await resolveAccountsForEmail(user.email);
  const accounts = [];
  for (const client of clients) {
    accounts.push(await buildAccount(client));
  }
  return { email: user.email, accounts };
}

async function createTicket(user: { id: string; email: string }, body: Record<string, unknown>) {
  const clientId = String(body.clientId || '').trim();
  const title = String(body.title || '').trim();
  const description = String(body.description || '').trim();
  const priority = normalizePriority(body.priority);

  if (!isUuid(clientId)) throw new PortalError('Ongeldige klant.', 400);
  if (!title) throw new PortalError('Geef een korte titel voor je ticket op.', 400);
  if (title.length > 200) throw new PortalError('De titel mag maximaal 200 tekens zijn.', 400);
  if (description.length > 5000) throw new PortalError('De omschrijving mag maximaal 5000 tekens zijn.', 400);

  // Het client_id NOOIT blind vertrouwen: opnieuw afleiden uit het geverifieerde
  // e-mailadres en controleren dat de klant in die set zit.
  const clients = await resolveAccountsForEmail(user.email);
  const client = clients.find((row) => row.id === clientId);
  if (!client) throw new PortalError('Geen toegang tot deze klant.', 403);

  const { data, error } = await supabaseAdmin
    .from('tickets')
    .insert({
      organization_id: client.organization_id,
      client_id: client.id,
      title,
      description: description || null,
      priority,
      status: 'new',
      created_by: user.id,
    })
    .select('*')
    .single();

  if (error) throw error;
  return { ticket: sanitizeTicket(data) };
}

async function getInvoicePdf(user: { id: string; email: string }, body: Record<string, unknown>) {
  const invoiceId = String(body.invoiceId || '').trim();
  if (!isUuid(invoiceId)) throw new PortalError('Ongeldige factuur.', 400);

  const clients = await resolveAccountsForEmail(user.email);
  if (clients.length === 0) throw new PortalError('Geen klantdossier gevonden voor dit account.', 404);

  const { data: invoice, error } = await supabaseAdmin
    .from('invoices')
    .select('id,organization_id,client_id,project_id,number,status')
    .eq('id', invoiceId)
    .maybeSingle();
  if (error) throw error;
  if (!invoice || invoice.status === 'draft') throw new PortalError('Factuur niet gevonden.', 404);

  await assertEntityBelongsToClients(invoice, clients);

  const { data: versions, error: versionError } = await supabaseAdmin
    .from('invoice_versions')
    .select('snapshot_reason,pdf_file_name,pdf_mime_type,pdf_size_bytes,pdf_sha256,pdf_data_base64,pdf_storage_provider,pdf_storage_key,version_number')
    .eq('organization_id', invoice.organization_id)
    .eq('invoice_id', invoice.id)
    .not('pdf_file_name', 'is', null)
    .order('version_number', { ascending: false })
    .limit(20);
  if (versionError) throw versionError;

  const usable = (versions || []).filter((candidate: Record<string, unknown>) => {
    const hasDbPdf = Boolean(String(candidate.pdf_data_base64 || '').trim());
    const hasStoragePdf = candidate.pdf_storage_provider === 'r2' && Boolean(candidate.pdf_storage_key);
    return hasDbPdf || hasStoragePdf;
  });
  const version = usable.find((candidate: Record<string, unknown>) => candidate.snapshot_reason === 'sent_to_client') || usable[0];
  if (!version) throw new PortalError('Er is nog geen beschikbare PDF voor deze factuur.', 404);

  let base64 = String(version.pdf_data_base64 || '').trim();
  if (!base64 && version.pdf_storage_provider === 'r2' && version.pdf_storage_key) {
    if (!INVOICE_PDF_STORAGE_WORKER_URL || !INVOICE_PDF_STORAGE_SECRET) {
      throw new PortalError('PDF is opgeslagen in private storage, maar de storage-koppeling ontbreekt.', 500);
    }
    const response = await fetch(`${INVOICE_PDF_STORAGE_WORKER_URL}/internal/invoice-snapshot/${encodeURIComponent(String(version.pdf_storage_key))}`, {
      headers: { Authorization: `Bearer ${INVOICE_PDF_STORAGE_SECRET}` },
    });
    if (!response.ok) throw new PortalError('PDF kon niet uit private storage worden opgehaald.', 502);
    base64 = arrayBufferToBase64(await response.arrayBuffer());
  }
  if (!base64) throw new PortalError('PDF ontbreekt of is niet beschikbaar.', 404);

  return {
    pdf: {
      fileName: version.pdf_file_name || `factuur-${invoice.number}.pdf`,
      mimeType: version.pdf_mime_type || 'application/pdf',
      sizeBytes: version.pdf_size_bytes || null,
      sha256: version.pdf_sha256 || null,
      base64,
    },
  };
}

// ── Dataopbouw ────────────────────────────────────────────────────────

async function resolveAccountsForEmail(email: string): Promise<ClientRow[]> {
  const { data, error } = await supabaseAdmin.rpc('portal_clients_for_email', { p_email: email });
  if (error) throw error;
  return (Array.isArray(data) ? data : []) as ClientRow[];
}

async function buildAccount(client: ClientRow) {
  const orgId = client.organization_id;

  const [company, projects] = await Promise.all([
    optionalCompany(orgId),
    selectRows('projects', (q) => q.eq('organization_id', orgId).eq('client_id', client.id).order('created_at', { ascending: false })),
  ]);
  const projectIds = projects.map((p: Record<string, unknown>) => String(p.id));

  // Facturen: alleen uitgegeven (geen concepten). Offertes: alleen die echt naar de
  // klant zijn verstuurd (sent_at gezet). Beide ook gekoppeld via projecten van de klant.
  const [invoices, quotes, tickets] = await Promise.all([
    selectRows('invoices', (q) => scopeToClient(q.eq('organization_id', orgId).neq('status', 'draft'), client.id, projectIds).order('date', { ascending: false })),
    selectRows('quotes', (q) => scopeToClient(q.eq('organization_id', orgId).not('sent_at', 'is', null), client.id, projectIds).order('date', { ascending: false })),
    selectRows('tickets', (q) => q.eq('organization_id', orgId).eq('client_id', client.id).order('created_at', { ascending: false })),
  ]);

  return {
    id: client.id,
    organizationId: orgId,
    company: sanitizeCompany(company),
    client: sanitizeClient(client),
    projects: projects.map(sanitizeProject),
    invoices: invoices.map(sanitizeInvoice),
    quotes: quotes.map(sanitizeQuote),
    tickets: tickets.map(sanitizeTicket),
  };
}

async function assertEntityBelongsToClients(entity: { client_id: string | null; project_id: string | null; organization_id: string }, clients: ClientRow[]) {
  const clientIds = new Set(clients.map((c) => c.id));
  if (entity.client_id && clientIds.has(entity.client_id)) return;
  if (entity.project_id) {
    const { data, error } = await supabaseAdmin
      .from('projects')
      .select('client_id')
      .eq('id', entity.project_id)
      .eq('organization_id', entity.organization_id)
      .maybeSingle();
    if (error) throw error;
    if (data?.client_id && clientIds.has(data.client_id)) return;
  }
  throw new PortalError('Geen toegang tot dit document.', 403);
}

// ── Query-helpers ─────────────────────────────────────────────────────

// Losse typering (any) net als de andere edge functions in deze repo: de
// PostgREST-builderketen is lastig exact te typen en wordt door Deno gedeployd,
// niet door de frontend-tsc.
// deno-lint-ignore no-explicit-any
type QueryBuilder = any;

function scopeToClient(query: QueryBuilder, clientId: string, projectIds: string[]): QueryBuilder {
  // PostgREST: client_id OF (project_id in projecten van de klant). Zonder projecten
  // alleen op client_id filteren. UUID's bevatten geen tekens die de or-filter breken.
  if (projectIds.length > 0) {
    return query.or(`client_id.eq.${clientId},project_id.in.(${projectIds.join(',')})`);
  }
  return query.eq('client_id', clientId);
}

async function selectRows(table: string, build: (q: QueryBuilder) => QueryBuilder): Promise<Record<string, unknown>[]> {
  const { data, error } = await build(supabaseAdmin.from(table).select('*'));
  if (error) throw error;
  return (data || []) as Record<string, unknown>[];
}

async function optionalCompany(organizationId: string) {
  try {
    const { data, error } = await supabaseAdmin.from('company_settings').select('*').eq('organization_id', organizationId).maybeSingle();
    if (error) {
      console.warn('client-portal company lookup failed', error.message);
      return null;
    }
    return data || null;
  } catch (error) {
    console.warn('client-portal company lookup crashed', error instanceof Error ? error.message : error);
    return null;
  }
}

// ── Saneren (alleen klantveilige velden) ──────────────────────────────

function sanitizeClient(row: Record<string, unknown> | null) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    contact_name: row.contact_name ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
  };
}

function sanitizeCompany(row: Record<string, unknown> | null) {
  if (!row) return null;
  return {
    company_name: row.company_name ?? null,
    trade_name: row.trade_name ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    website: row.website ?? null,
    city: row.city ?? null,
    country: row.country ?? null,
    iban: row.iban ?? null,
    vat_number: row.vat_number ?? null,
    kvk_number: row.kvk_number ?? null,
  };
}

function sanitizeProject(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    color: row.color ?? null,
    archived: Boolean(row.archived),
    start_date: row.start_date ?? null,
    end_date: row.end_date ?? null,
    created_at: row.created_at,
  };
}

function sanitizeInvoice(row: Record<string, unknown>) {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    due_date: row.due_date ?? null,
    status: row.status,
    lines: Array.isArray(row.lines) ? row.lines : [],
    notes: row.notes ?? null,
    sent_at: row.sent_at ?? null,
    paid_at: row.paid_at ?? null,
    project_id: row.project_id ?? null,
  };
}

function sanitizeQuote(row: Record<string, unknown>) {
  return {
    id: row.id,
    number: row.number,
    date: row.date,
    valid_until: row.valid_until ?? null,
    status: row.status,
    lines: Array.isArray(row.lines) ? row.lines : [],
    notes: row.notes ?? null,
    sent_at: row.sent_at ?? null,
    accepted_at: row.accepted_at ?? null,
    project_id: row.project_id ?? null,
  };
}

function sanitizeTicket(row: Record<string, unknown>) {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    status: row.status,
    priority: row.priority,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ── Generieke helpers ─────────────────────────────────────────────────

async function requireUser(req: Request): Promise<{ id: string; email: string }> {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) throw new PortalError('Niet ingelogd: Authorization header ontbreekt.', 401);
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) throw new PortalError('Niet ingelogd of ongeldige sessie.', 401);
  const email = (data.user.email || '').trim();
  if (!email) throw new PortalError('Aan deze login is geen e-mailadres gekoppeld.', 403);
  return { id: data.user.id, email };
}

function normalizePriority(value: unknown): 'low' | 'med' | 'high' {
  const v = String(value || '').toLowerCase();
  return v === 'low' || v === 'high' ? v : 'med';
}

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

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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
  throw new PortalError('Deze frontend-origin is niet toegestaan voor het klantportaal.', 403);
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
