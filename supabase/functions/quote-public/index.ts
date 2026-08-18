import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { loadBranding } from '../_shared/branding.ts';

type QuoteLine = { id?: string; description: string; quantity: number; unit_price: number; vat?: number };
type PublicQuote = {
  id: string;
  organization_id: string;
  client_id: string | null;
  project_id: string | null;
  number: string;
  date: string;
  valid_until: string | null;
  lines: QuoteLine[];
  status: string;
  notes: string | null;
  public_token_expires_at: string | null;
  accepted_at: string | null;
  client_decision_at: string | null;
  client_decision_by_name: string | null;
  client_decision_by_email: string | null;
  client_decision_note: string | null;
};

type PublicHttpErrorStatus = 400 | 401 | 403 | 404 | 405 | 409 | 410 | 422 | 500;

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
const QUOTE_PUBLIC_ALLOWED_ORIGINS = (Deno.env.get('QUOTE_PUBLIC_ALLOWED_ORIGINS') || Deno.env.get('QUOTE_ALLOWED_ORIGINS') || Deno.env.get('BILLING_ALLOWED_RETURN_ORIGINS') || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const QUOTE_ALLOW_LOCAL_DEV = (Deno.env.get('QUOTE_ALLOW_LOCAL_DEV') || 'false').toLowerCase() === 'true';

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

class PublicHttpError extends Error {
  status: PublicHttpErrorStatus;
  constructor(message: string, status: PublicHttpErrorStatus = 400) {
    super(message);
    this.name = 'PublicHttpError';
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
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(body.action || 'getQuote');
    const token = String(body.token || '').trim();
    if (!token || token.length < 24) throw new PublicHttpError('Offertelink ontbreekt of is ongeldig.', 400);
    const tokenHash = await sha256Hex(token);

    switch (action) {
      case 'getQuote': return json(req, { ok: true, ...(await getPublicQuote(tokenHash)) });
      case 'acceptQuote': return json(req, { ok: true, ...(await decidePublicQuote('accept', tokenHash, body)) });
      case 'rejectQuote': return json(req, { ok: true, ...(await decidePublicQuote('reject', tokenHash, body)) });
      default: return json(req, { ok: false, error: `Onbekende publieke offerte-actie: ${action}` }, 400);
    }
  } catch (error) {
    const status = error instanceof PublicHttpError ? error.status : 500;
    const internalMessage = describeError(error);
    if (status >= 500) console.error('quote-public error', internalMessage, error instanceof Error ? error.stack : undefined);
    // Voor non-PublicHttpError fouten geven we de werkelijke reden mee (afgekapt op
    // 500 chars). Postgres/Supabase-foutmeldingen bevatten doorgaans veldnamen en
    // constraint-namen, geen secrets — diagnostisch te zien is veilig en cruciaal
    // bij het opsporen van migratie- of configuratieproblemen op staging.
    const publicMessage = error instanceof PublicHttpError
      ? error.message
      : `Offerte kon niet worden geladen: ${internalMessage}`.slice(0, 500);
    return json(req, { ok: false, error: publicMessage }, status);
  }
});

async function getPublicQuote(tokenHash: string) {
  const quote = await loadQuoteByTokenHash(tokenHash);
  await insertClientViewedEvent(quote.organization_id, quote.id);
  const [client, project, company, branding, events] = await Promise.all([
    quote.client_id ? loadClient(quote.organization_id, quote.client_id) : Promise.resolve(null),
    quote.project_id ? loadProject(quote.organization_id, quote.project_id) : Promise.resolve(null),
    loadCompanySettings(quote.organization_id),
    loadBranding(supabaseAdmin, quote.organization_id),
    loadQuoteEvents(quote.organization_id, quote.id),
  ]);
  return { quote: publicQuotePayload(quote), client, project, company, branding, events };
}

async function decidePublicQuote(kind: 'accept' | 'reject', tokenHash: string, body: Record<string, unknown>) {
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const note = String(body.note || '').trim();
  if (!name) throw new PublicHttpError('Vul je naam in om de offerte te bevestigen.', 422);
  if (!isEmail(email)) throw new PublicHttpError('Vul een geldig e-mailadres in.', 422);

  const rpcName = kind === 'accept' ? 'accept_quote_public' : 'reject_quote_public';
  const { data, error } = await supabaseAdmin.rpc(rpcName, {
    p_token_hash: tokenHash,
    p_name: name,
    p_email: email,
    p_note: note || null,
  });
  if (error) {
    if (/ongeldig|verlopen|niet meer/i.test(error.message)) throw new PublicHttpError(error.message, 409);
    throw error;
  }
  const row = Array.isArray(data) ? data[0] : data;
  const quote = row as PublicQuote;
  // Ook na "Akkoord geven" moet de huisstijl mee: de frontend vervangt de hele
  // payload met dit antwoord, en zonder branding klapt de pagina op dat moment
  // terug naar de ResoFly-stijl.
  const [client, project, company, branding, events] = await Promise.all([
    quote.client_id ? loadClient(quote.organization_id, quote.client_id) : Promise.resolve(null),
    quote.project_id ? loadProject(quote.organization_id, quote.project_id) : Promise.resolve(null),
    loadCompanySettings(quote.organization_id),
    loadBranding(supabaseAdmin, quote.organization_id),
    loadQuoteEvents(quote.organization_id, quote.id),
  ]);
  return { quote: publicQuotePayload(quote), client, project, company, branding, events };
}

async function loadQuoteByTokenHash(tokenHash: string): Promise<PublicQuote> {
  const { data, error } = await supabaseAdmin
    .from('quotes')
    .select('id,organization_id,client_id,project_id,number,date,valid_until,lines,status,notes,public_token_expires_at,accepted_at,client_decision_at,client_decision_by_name,client_decision_by_email,client_decision_note')
    .eq('public_token_hash', tokenHash)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new PublicHttpError('Offertelink is ongeldig of verlopen.', 404);
  const quote = data as PublicQuote;
  if (!quote.public_token_expires_at || new Date(quote.public_token_expires_at).getTime() < Date.now()) {
    throw new PublicHttpError('Deze offertelink is verlopen.', 410);
  }
  if (quote.status === 'sent' && isDateBeforeToday(quote.valid_until)) {
    throw new PublicHttpError('Deze offerte is verlopen en kan niet meer publiek worden beoordeeld.', 410);
  }
  if (!['sent', 'accepted', 'rejected', 'expired', 'cancelled'].includes(quote.status)) {
    throw new PublicHttpError('Deze offerte is nog niet beschikbaar voor publieke beoordeling.', 409);
  }
  return quote;
}

async function loadClient(organizationId: string, clientId: string) {
  const { data, error } = await supabaseAdmin
    .from('clients')
    .select('id,name,contact_name,email,phone')
    .eq('organization_id', organizationId)
    .eq('id', clientId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

async function loadProject(organizationId: string, projectId: string) {
  const { data, error } = await supabaseAdmin
    .from('projects')
    .select('id,name,description,start_date,end_date')
    .eq('organization_id', organizationId)
    .eq('id', projectId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

async function loadCompanySettings(organizationId: string) {
  const { data, error } = await supabaseAdmin
    .from('company_settings')
    .select('company_name,trade_name,email,phone,website,address_line1,address_line2,postal_code,city,country,kvk_number,vat_number')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

async function loadQuoteEvents(organizationId: string, quoteId: string) {
  const { data, error } = await supabaseAdmin
    .from('quote_approval_events')
    .select('id,event_type,title,description,metadata,created_at')
    .eq('organization_id', organizationId)
    .eq('quote_id', quoteId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function insertQuoteWorkflowEvent(organizationId: string, quoteId: string, actorUserId: string | null, eventType: string, title: string, description?: string | null, metadata: Record<string, unknown> = {}) {
  const { error } = await supabaseAdmin.rpc('insert_quote_workflow_event', {
    p_organization_id: organizationId,
    p_quote_id: quoteId,
    p_event_type: eventType,
    p_title: title,
    p_description: description ?? null,
    p_metadata: metadata,
    p_actor_user_id: actorUserId,
  });
  if (error) console.warn('Quote workflow event insert failed', error.message);
}

async function insertClientViewedEvent(organizationId: string, quoteId: string): Promise<void> {
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('quote_approval_events')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('quote_id', quoteId)
    .eq('event_type', 'client_viewed')
    .gte('created_at', since)
    .limit(1);
  if (error) {
    console.warn('Quote view throttle check failed', error.message);
  }
  if (data && data.length > 0) return;
  await insertQuoteWorkflowEvent(organizationId, quoteId, null, 'client_viewed', 'Klant heeft de offerte geopend', null, { source: 'public_quote_page' });
}

function publicQuotePayload(quote: PublicQuote) {
  return {
    id: quote.id,
    number: quote.number,
    date: quote.date,
    valid_until: quote.valid_until,
    lines: quote.lines,
    status: quote.status,
    notes: quote.notes,
    public_token_expires_at: quote.public_token_expires_at,
    accepted_at: quote.accepted_at,
    client_decision_at: quote.client_decision_at,
    client_decision_by_name: quote.client_decision_by_name,
    client_decision_by_email: quote.client_decision_by_email,
    client_decision_note: quote.client_decision_note,
  };
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get('origin') || '';
  const allowOrigin = QUOTE_PUBLIC_ALLOWED_ORIGINS.includes(origin) || (QUOTE_ALLOW_LOCAL_DEV && isLocalOrigin(origin))
    ? origin
    : (QUOTE_ALLOW_LOCAL_DEV && !origin ? '*' : 'null');
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
  if (!origin && QUOTE_ALLOW_LOCAL_DEV) return;
  if (QUOTE_PUBLIC_ALLOWED_ORIGINS.includes(origin)) return;
  if (QUOTE_ALLOW_LOCAL_DEV && isLocalOrigin(origin)) return;
  if (QUOTE_PUBLIC_ALLOWED_ORIGINS.length === 0 && QUOTE_ALLOW_LOCAL_DEV) return;
  if (QUOTE_PUBLIC_ALLOWED_ORIGINS.length === 0) throw new PublicHttpError('QUOTE_PUBLIC_ALLOWED_ORIGINS of QUOTE_ALLOWED_ORIGINS is verplicht in productie.', 500);
  throw new PublicHttpError('Deze frontend-origin is niet toegestaan voor publieke offerte-acties.', 403);
}

function isLocalOrigin(origin: string): boolean {
  return ['http://localhost:5173', 'http://127.0.0.1:5173'].includes(origin);
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isDateBeforeToday(value: string | null): boolean {
  if (!value) return false;
  const parsed = Date.parse(`${value}T23:59:59`);
  if (!Number.isFinite(parsed)) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return parsed < today.getTime();
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
