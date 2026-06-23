import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

// ============================================================
// bank-sync — directe PSD2-bankkoppeling via GoCardless Bank Account Data.
//
// Acties (POST, met Supabase bearer token van een organisatielid):
//  - listInstitutions  : banken voor de bankkiezer (lezen, elk lid)
//  - createRequisition : start consent; geeft de redirect-link terug (schrijfrol)
//  - finalizeRequisition: na de redirect; koppelt rekeningen + 1e sync (schrijfrol)
//  - sync              : nieuwe transacties ophalen voor 1/alle rekeningen (schrijfrol)
//
// De GoCardless-credentials (GOCARDLESS_SECRET_ID/KEY) zijn app-breed (de app is de
// TPP) en staan als Edge-Function-secrets. Per organisatie bewaren we alleen de
// requisitions + de gekoppelde rekeningen. Schrijven gebeurt met de service-role,
// dus de import-RPC ziet auth.role()='service_role' en slaat de can_write_org-check over.
// ============================================================

type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer';
type HttpStatus = 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502;

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
const GOCARDLESS_SECRET_ID = Deno.env.get('GOCARDLESS_SECRET_ID') || '';
const GOCARDLESS_SECRET_KEY = Deno.env.get('GOCARDLESS_SECRET_KEY') || '';
const GOCARDLESS_BASE_URL = (Deno.env.get('GOCARDLESS_BASE_URL') || 'https://bankaccountdata.gocardless.com/api/v2').replace(/\/$/, '');
const GOCARDLESS_COUNTRY = (Deno.env.get('GOCARDLESS_COUNTRY') || 'nl').toLowerCase();
const BANK_ALLOWED_ORIGINS = parseAllowedOrigins([
  Deno.env.get('BANK_ALLOWED_ORIGINS'), Deno.env.get('APP_PUBLIC_URL'),
  Deno.env.get('INVOICE_ALLOWED_ORIGINS'), Deno.env.get('QUOTE_ALLOWED_ORIGINS'), Deno.env.get('BILLING_ALLOWED_RETURN_ORIGINS'),
]);
const BANK_ALLOW_LOCAL_DEV = (Deno.env.get('BANK_ALLOW_LOCAL_DEV') || Deno.env.get('INVOICE_ALLOW_LOCAL_DEV') || 'false').toLowerCase() === 'true';
const BANK_DEBUG_ERRORS = (Deno.env.get('BANK_DEBUG_ERRORS') || 'false').toLowerCase() === 'true';
// GoCardless-sandbox waarmee je de volledige consent-flow kunt testen zonder echte bank.
const SANDBOX_INSTITUTION = { id: 'SANDBOXFINANCE_SFIN0000', name: 'Sandbox Finance (test)', bic: null, logo: null, transaction_total_days: 90 };

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

class HttpError extends Error {
  status: HttpStatus;
  constructor(message: string, status: HttpStatus = 400) { super(message); this.name = 'HttpError'; this.status = status; }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return json(req, { ok: true });
  try {
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Method not allowed.' }, 405);
    assertAllowedOrigin(req);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || '');
    const user = await requireUser(req);

    // finalize leidt de organisatie af uit de requisition (de gebruiker kan tussen
    // koppelen en terugkeren van actieve org gewisseld zijn), niet uit de body.
    if (action === 'finalizeRequisition') {
      return json(req, { ok: true, ...(await finalizeRequisition(user.id, String(body.reference || ''))) });
    }

    const organizationId = String(body.organizationId || '');
    const role = await requireOrganizationAccess(user.id, organizationId);

    if (action === 'listInstitutions') {
      return json(req, { ok: true, institutions: await listInstitutions(String(body.country || '') || GOCARDLESS_COUNTRY) });
    }

    if (!['owner', 'admin', 'member'].includes(role)) throw new HttpError('Geen schrijfrechten voor deze organisatie.', 403);

    switch (action) {
      case 'createRequisition':
        return json(req, { ok: true, ...(await createRequisition(req, user.id, organizationId, body)) });
      case 'sync':
        return json(req, { ok: true, ...(await syncAccounts(organizationId, body.bankAccountId ? String(body.bankAccountId) : null)) });
      default:
        return json(req, { ok: false, error: `Onbekende bank-sync action: ${action}` }, 400);
    }
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const internal = describeError(error);
    if (status >= 500) console.error('bank-sync error', internal); else console.warn('bank-sync warning', internal);
    const publicMessage = error instanceof HttpError ? error.message
      : BANK_DEBUG_ERRORS ? `Bank-sync mislukt: ${internal}` : 'Bankkoppeling mislukt door een server- of providerfout. Controleer de Edge Function logs.';
    return json(req, { ok: false, error: publicMessage }, status);
  }
});

// ── GoCardless client ──────────────────────────────────────────────────────

async function gcToken(): Promise<string> {
  if (!GOCARDLESS_SECRET_ID || !GOCARDLESS_SECRET_KEY) {
    throw new HttpError('GOCARDLESS_SECRET_ID/GOCARDLESS_SECRET_KEY ontbreken in de Edge Function secrets.', 500);
  }
  const res = await fetch(`${GOCARDLESS_BASE_URL}/token/new/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ secret_id: GOCARDLESS_SECRET_ID, secret_key: GOCARDLESS_SECRET_KEY }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access) {
    throw new HttpError(`GoCardless-authenticatie mislukt (${res.status}). Controleer de credentials.`, 502);
  }
  return data.access as string;
}

async function gc(path: string, token: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${GOCARDLESS_BASE_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(init?.headers || {}) },
  });
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const detail = data?.detail || data?.summary || (Array.isArray(data?.institution_id) ? data.institution_id.join(' ') : '') || text.slice(0, 200);
    const err = new HttpError(`GoCardless-fout (${res.status}): ${detail || 'onbekend'}`, res.status === 401 ? 401 : 502);
    (err as any).gcStatus = res.status;
    throw err;
  }
  return data;
}

// ── Acties ───────────────────────────────────────────────────────────────

async function listInstitutions(country: string): Promise<unknown[]> {
  const token = await gcToken();
  const list = await gc(`/institutions/?country=${encodeURIComponent(country)}`, token);
  const institutions = (Array.isArray(list) ? list : []).map((i: any) => ({
    id: i.id, name: i.name, bic: i.bic ?? null, logo: i.logo ?? null, transaction_total_days: Number(i.transaction_total_days) || null,
  }));
  return [...institutions, SANDBOX_INSTITUTION];
}

async function createRequisition(req: Request, userId: string, organizationId: string, body: Record<string, unknown>) {
  const institutionId = String(body.institutionId || '').trim();
  const institutionName = body.institutionName ? String(body.institutionName) : null;
  const redirectUrl = String(body.redirectUrl || '').trim();
  if (!institutionId) throw new HttpError('Kies een bank.', 400);
  assertRedirectAllowed(req, redirectUrl);

  const token = await gcToken();
  const reference = crypto.randomUUID();
  const requisition = await gc('/requisitions/', token, {
    method: 'POST',
    body: JSON.stringify({ redirect: redirectUrl, institution_id: institutionId, reference, user_language: 'NL' }),
  });
  if (!requisition?.id || !requisition?.link) throw new HttpError('GoCardless gaf geen geldige koppel-link terug.', 502);

  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabaseAdmin.from('bank_requisitions').insert({
    organization_id: organizationId, created_by: userId, provider: 'gocardless',
    institution_id: institutionId, institution_name: institutionName, reference,
    requisition_id: requisition.id, link: requisition.link, status: 'created', expires_at: expiresAt,
  });
  if (error) throw new HttpError(`Kon de koppeling niet vastleggen: ${error.message}`, 500);

  return { link: requisition.link as string, reference };
}

async function finalizeRequisition(userId: string, reference: string) {
  if (!reference) throw new HttpError('Ontbrekende referentie.', 400);
  const { data: reqRow, error: reqErr } = await supabaseAdmin
    .from('bank_requisitions').select('*').eq('reference', reference).limit(1).maybeSingle();
  if (reqErr) throw new HttpError(`Requisition-lookup mislukt: ${reqErr.message}`, 500);
  if (!reqRow) throw new HttpError('Koppeling niet gevonden.', 404);

  const organizationId = reqRow.organization_id as string;
  const role = await requireOrganizationAccess(userId, organizationId);
  if (!['owner', 'admin', 'member'].includes(role)) throw new HttpError('Geen schrijfrechten voor deze organisatie.', 403);

  const token = await gcToken();
  const requisition = await gc(`/requisitions/${reqRow.requisition_id}/`, token);
  const status = String(requisition?.status || '');
  const accountIds: string[] = Array.isArray(requisition?.accounts) ? requisition.accounts : [];

  if (status !== 'LN' || accountIds.length === 0) {
    // CR/GC/UA/RJ/EX etc.: nog niet gekoppeld of geweigerd.
    const mapped = status === 'EX' ? 'expired' : status === 'RJ' ? 'error' : 'created';
    await supabaseAdmin.from('bank_requisitions').update({ status: mapped, error: status }).eq('id', reqRow.id);
    return { status: mapped, linked: 0, imported: 0 };
  }

  // Bepaal de grootboek-bankrekening (1100) waar nieuwe rekeningen op boeken.
  const ledgerAccountId = await defaultBankLedgerAccount(organizationId);

  let linked = 0;
  for (const accountId of accountIds) {
    let iban: string | null = null;
    let name = reqRow.institution_name || 'Bankrekening';
    try {
      const meta = await gc(`/accounts/${accountId}/`, token);
      iban = meta?.iban ?? null;
      try {
        const details = await gc(`/accounts/${accountId}/details/`, token);
        name = details?.account?.name || details?.account?.ownerName || (iban ? `${reqRow.institution_name || 'Bank'} ${iban.slice(-4)}` : name);
      } catch { /* details optioneel */ }
    } catch { /* metadata optioneel */ }

    // Bestaat de rekening al (her-koppeling), werk dan alleen de metadata + consent bij —
    // NIET de grootboekrekening, zodat een eerder door de gebruiker gekozen mapping blijft.
    const { data: existing } = await supabaseAdmin.from('bank_accounts').select('id')
      .eq('organization_id', organizationId).eq('external_account_id', accountId).limit(1).maybeSingle();
    if (existing) {
      const { error: updErr } = await supabaseAdmin.from('bank_accounts').update({
        name, iban, provider: 'gocardless', source: 'gocardless', bank_requisition_id: reqRow.id, is_active: true,
      }).eq('id', existing.id);
      if (!updErr) linked += 1;
    } else {
      const { error: insErr } = await supabaseAdmin.from('bank_accounts').insert({
        organization_id: organizationId, created_by: userId, name, iban, currency: 'EUR',
        ledger_account_id: ledgerAccountId, source: 'gocardless', provider: 'gocardless',
        external_account_id: accountId, bank_requisition_id: reqRow.id, is_active: true,
      });
      if (!insErr) linked += 1;
    }
  }

  await supabaseAdmin.from('bank_requisitions').update({
    status: 'linked', accounts: accountIds, linked_at: new Date().toISOString(), error: null,
  }).eq('id', reqRow.id);

  const synced = await syncAccounts(organizationId, null);
  const imported = synced.results.reduce((s, r) => s + (r.inserted || 0), 0);
  return { status: 'linked', linked, imported };
}

async function syncAccounts(organizationId: string, bankAccountId: string | null) {
  let query = supabaseAdmin.from('bank_accounts').select('*')
    .eq('organization_id', organizationId).eq('source', 'gocardless').eq('is_active', true);
  if (bankAccountId) query = query.eq('id', bankAccountId);
  const { data: accounts, error } = await query;
  if (error) throw new HttpError(`Bankrekeningen ophalen mislukt: ${error.message}`, 500);
  if (!accounts || accounts.length === 0) return { results: [], needsReconsent: false };

  const token = await gcToken();
  const results: Array<{ bankAccountId: string; inserted: number; skipped: number; error?: string }> = [];
  let needsReconsent = false;

  for (const acc of accounts) {
    if (!acc.external_account_id) { results.push({ bankAccountId: acc.id, inserted: 0, skipped: 0, error: 'geen extern account-id' }); continue; }
    const since = acc.last_synced_at ? new Date(new Date(acc.last_synced_at).getTime() - 7 * 24 * 60 * 60 * 1000) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const dateFrom = since.toISOString().slice(0, 10);
    try {
      const resp = await gc(`/accounts/${acc.external_account_id}/transactions/?date_from=${dateFrom}`, token);
      const booked: any[] = resp?.transactions?.booked ?? [];
      const txns = booked.map(mapGoCardlessTransaction).filter((t) => t.booking_date && t.amount_cents !== 0);
      const dates = txns.map((t) => t.booking_date).sort();
      const statement = {
        format: 'gocardless', file_name: null, file_hash: null,
        period_start: dates[0] ?? null, period_end: dates[dates.length - 1] ?? null,
        opening_balance_cents: null, closing_balance_cents: null,
      };
      let inserted = 0, skipped = 0;
      if (txns.length > 0) {
        const { data: imp, error: impErr } = await supabaseAdmin.rpc('import_bank_transactions', {
          p_organization_id: organizationId, p_bank_account_id: acc.id, p_statement: statement, p_transactions: txns,
        });
        if (impErr) throw new Error(impErr.message);
        inserted = (imp as any)?.inserted ?? 0; skipped = (imp as any)?.skipped ?? 0;
      }
      await supabaseAdmin.from('bank_accounts').update({ last_synced_at: new Date().toISOString() }).eq('id', acc.id);
      results.push({ bankAccountId: acc.id, inserted, skipped });
    } catch (e) {
      const gcStatus = (e as any)?.gcStatus;
      if (gcStatus === 401 || gcStatus === 403) {
        needsReconsent = true;
        if (acc.bank_requisition_id) await supabaseAdmin.from('bank_requisitions').update({ status: 'expired' }).eq('id', acc.bank_requisition_id);
      }
      results.push({ bankAccountId: acc.id, inserted: 0, skipped: 0, error: describeError(e) });
    }
  }
  return { results, needsReconsent };
}

// ── Mapping + helpers ──────────────────────────────────────────────────────

function mapGoCardlessTransaction(tx: any) {
  const amountStr = tx?.transactionAmount?.amount ?? '0';
  const cents = Math.round((parseFloat(amountStr) || 0) * 100);
  const id = tx?.transactionId || tx?.internalTransactionId || null;
  const bookingDate = (tx?.bookingDate || tx?.bookingDateTime || tx?.valueDate || '').slice(0, 10) || null;
  const valueDate = (tx?.valueDate || tx?.valueDateTime || '').slice(0, 10) || null;
  const incoming = cents > 0;
  const counterpartyName = (incoming ? tx?.debtorName : tx?.creditorName) || null;
  const counterpartyIban = (incoming ? tx?.debtorAccount?.iban : tx?.creditorAccount?.iban) || null;
  const remittance = tx?.remittanceInformationUnstructured
    || (Array.isArray(tx?.remittanceInformationUnstructuredArray) ? tx.remittanceInformationUnstructuredArray.join(' ') : '')
    || tx?.additionalInformation || '';
  const endToEnd = tx?.endToEndId && tx.endToEndId !== 'NOTPROVIDED' ? tx.endToEndId : null;
  const dedupKey = id ? `tx:${id}` : `gc:${cyrb53(`${bookingDate}|${cents}|${counterpartyIban || ''}|${remittance}`)}`;
  return {
    dedup_key: dedupKey, booking_date: bookingDate, value_date: valueDate, amount_cents: cents,
    currency: tx?.transactionAmount?.currency || 'EUR', counterparty_name: counterpartyName,
    counterparty_iban: counterpartyIban, description: remittance || null, structured_reference: null,
    end_to_end_id: endToEnd, bank_tx_id: id,
  };
}

async function defaultBankLedgerAccount(organizationId: string): Promise<string> {
  // Eerst de systeem-bankrekening (subtype 'bank'), anders code 1100.
  const { data } = await supabaseAdmin.from('ledger_accounts').select('id,code,subtype')
    .eq('organization_id', organizationId).in('code', ['1100']).limit(1);
  const { data: bySubtype } = await supabaseAdmin.from('ledger_accounts').select('id')
    .eq('organization_id', organizationId).eq('subtype', 'bank').limit(1);
  const id = bySubtype?.[0]?.id || data?.[0]?.id;
  if (!id) throw new HttpError('Geen bank-grootboekrekening (1100) gevonden. Richt eerst je rekeningschema in.', 422);
  return id as string;
}

function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i += 1) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

function assertRedirectAllowed(req: Request, redirectUrl: string): void {
  if (!redirectUrl) throw new HttpError('Ontbrekende redirect-URL.', 400);
  let origin = '';
  try { origin = new URL(redirectUrl).origin; } catch { throw new HttpError('Ongeldige redirect-URL.', 400); }
  if (BANK_ALLOWED_ORIGINS.includes(origin)) return;
  if (BANK_ALLOW_LOCAL_DEV && isLocalOrigin(origin)) return;
  const reqOrigin = req.headers.get('origin') || '';
  if (reqOrigin && origin === reqOrigin && (BANK_ALLOWED_ORIGINS.includes(reqOrigin) || (BANK_ALLOW_LOCAL_DEV && isLocalOrigin(reqOrigin)))) return;
  if (BANK_ALLOWED_ORIGINS.length === 0 && BANK_ALLOW_LOCAL_DEV) return;
  throw new HttpError('Deze redirect-URL is niet toegestaan.', 403);
}

async function requireUser(req: Request): Promise<{ id: string; email?: string }> {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError('Niet ingelogd: Authorization header ontbreekt.', 401);
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) throw new HttpError('Niet ingelogd of ongeldig sessietoken.', 401);
  return { id: data.user.id, email: data.user.email || undefined };
}

async function requireOrganizationAccess(userId: string, organizationId: string): Promise<OrganizationRole> {
  if (!isUuid(organizationId)) throw new HttpError('Ongeldige organisatie.', 400);
  const { data, error } = await supabaseAdmin.from('organization_members').select('role')
    .eq('organization_id', organizationId).eq('user_id', userId).eq('status', 'active').limit(1);
  if (error) throw new HttpError(`organization_members lookup mislukt: ${error.message}`, 500);
  const role = data?.[0]?.role as OrganizationRole | undefined;
  if (!role) throw new HttpError('Geen toegang tot deze organisatie.', 403);
  return role;
}

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get('origin') || '';
  const allowOrigin = BANK_ALLOWED_ORIGINS.includes(origin) || (BANK_ALLOW_LOCAL_DEV && isLocalOrigin(origin))
    ? origin : BANK_ALLOW_LOCAL_DEV && !origin ? '*' : 'null';
  return { 'Access-Control-Allow-Origin': allowOrigin, 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin' };
}
function json(req: Request, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } });
}
function assertAllowedOrigin(req: Request): void {
  const origin = req.headers.get('origin') || '';
  if (!origin && BANK_ALLOW_LOCAL_DEV) return;
  if (BANK_ALLOWED_ORIGINS.includes(origin)) return;
  if (BANK_ALLOW_LOCAL_DEV && isLocalOrigin(origin)) return;
  if (BANK_ALLOWED_ORIGINS.length === 0 && BANK_ALLOW_LOCAL_DEV) return;
  if (BANK_ALLOWED_ORIGINS.length === 0) throw new HttpError('BANK_ALLOWED_ORIGINS of APP_PUBLIC_URL is verplicht in productie.', 500);
  throw new HttpError('Deze frontend-origin is niet toegestaan voor bank-sync.', 403);
}
function isLocalOrigin(origin: string): boolean { return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin); }
function parseAllowedOrigins(values: Array<string | null | undefined>): string[] {
  const origins = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const rawPart of value.split(',')) {
      const part = rawPart.trim().replace(/\/$/, '');
      if (!part) continue;
      if (part.startsWith('http://') || part.startsWith('https://')) { try { origins.add(new URL(part).origin); } catch { origins.add(part); } }
      else origins.add(part);
    }
  }
  return [...origins];
}
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function describeError(error: unknown): string { if (error instanceof Error) return error.message; try { return JSON.stringify(error); } catch { return String(error); } }
function requiredEnv(name: string): string { const value = Deno.env.get(name); if (!value) throw new Error(`Missing required env var: ${name}`); return value; }
