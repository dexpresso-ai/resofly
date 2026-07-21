import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

// ============================================================
// bank-sync — directe PSD2-bankkoppeling via Enable Banking (EU/Fins AISP).
//
// Acties (POST, met Supabase bearer token van een organisatielid):
//  - listInstitutions   : banken (ASPSP's) voor de bankkiezer (lezen, elk lid)
//  - createRequisition  : start consent; geeft de redirect-link terug (schrijfrol)
//  - finalizeRequisition: na de redirect (?code=&state=); koppelt rekeningen + 1e sync
//  - sync               : nieuwe transacties ophalen voor 1/alle rekeningen (schrijfrol)
//
// Auth richting Enable Banking: een JWT (RS256), gesigneerd met de private sleutel
// (ENABLEBANKING_PRIVATE_KEY, PKCS#8 PEM) en kid = ENABLEBANKING_APP_ID. App-breed
// (de app is de TPP). Per organisatie bewaren we alleen requisitions + gekoppelde
// rekeningen. Schrijven met de service-role, dus de import-RPC ziet
// auth.role()='service_role' en slaat de can_write_org-check over.
// ============================================================

type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer';
type HttpStatus = 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502;

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
const EB_APP_ID = Deno.env.get('ENABLEBANKING_APP_ID') || '';
const EB_PRIVATE_KEY = (Deno.env.get('ENABLEBANKING_PRIVATE_KEY') || '').replace(/\\n/g, '\n');
const EB_BASE_URL = (Deno.env.get('ENABLEBANKING_BASE_URL') || 'https://api.enablebanking.com').replace(/\/$/, '');
const EB_COUNTRY = (Deno.env.get('ENABLEBANKING_COUNTRY') || 'NL').toUpperCase();
const EB_PSU_TYPE = (Deno.env.get('ENABLEBANKING_PSU_TYPE') || 'business').toLowerCase();
const EB_CONSENT_DAYS = parsePositiveInt(Deno.env.get('ENABLEBANKING_CONSENT_DAYS'), 90);
const BANK_ALLOWED_ORIGINS = parseAllowedOrigins([
  Deno.env.get('BANK_ALLOWED_ORIGINS'), Deno.env.get('APP_PUBLIC_URL'),
  Deno.env.get('INVOICE_ALLOWED_ORIGINS'), Deno.env.get('QUOTE_ALLOWED_ORIGINS'), Deno.env.get('BILLING_ALLOWED_RETURN_ORIGINS'),
]);
const BANK_ALLOW_LOCAL_DEV = (Deno.env.get('BANK_ALLOW_LOCAL_DEV') || Deno.env.get('INVOICE_ALLOW_LOCAL_DEV') || 'false').toLowerCase() === 'true';
const BANK_DEBUG_ERRORS = (Deno.env.get('BANK_DEBUG_ERRORS') || 'false').toLowerCase() === 'true';

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

    // finalize leidt de organisatie af uit de requisition (state), niet uit de body.
    if (action === 'finalizeRequisition') {
      return json(req, { ok: true, ...(await finalizeRequisition(user.id, String(body.code || ''), String(body.state || ''))) });
    }

    const organizationId = String(body.organizationId || '');
    const role = await requireOrganizationAccess(user.id, organizationId);

    if (action === 'listInstitutions') {
      return json(req, { ok: true, institutions: await listInstitutions(String(body.country || '') || EB_COUNTRY) });
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

// ── Enable Banking client (JWT RS256 + REST) ────────────────────────────────

let cachedJwt: { token: string; exp: number } | null = null;
async function ebJwt(): Promise<string> {
  if (!EB_APP_ID || !EB_PRIVATE_KEY) {
    throw new HttpError('ENABLEBANKING_APP_ID/ENABLEBANKING_PRIVATE_KEY ontbreken in de Edge Function secrets.', 500);
  }
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && cachedJwt.exp - 60 > now) return cachedJwt.token;
  const exp = now + 3600;
  const header = { typ: 'JWT', alg: 'RS256', kid: EB_APP_ID };
  const payload = { iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp };
  const signingInput = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(payload))}`;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('pkcs8', pemToDer(EB_PRIVATE_KEY), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch {
    throw new HttpError('ENABLEBANKING_PRIVATE_KEY kon niet worden gelezen (verwacht een PKCS#8 PEM-sleutel).', 500);
  }
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput)));
  const token = `${signingInput}.${b64url(sig)}`;
  cachedJwt = { token, exp };
  return token;
}

async function eb(path: string, init?: RequestInit): Promise<any> {
  const token = await ebJwt();
  const res = await fetch(`${EB_BASE_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(init?.headers || {}) },
  });
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const detail = data?.message || data?.detail || data?.error || text.slice(0, 200);
    const err = new HttpError(`Enable Banking-fout (${res.status}): ${detail || 'onbekend'}`, res.status === 401 ? 401 : 502);
    (err as any).ebStatus = res.status;
    throw err;
  }
  return data;
}

// ── Acties ───────────────────────────────────────────────────────────────

async function listInstitutions(country: string): Promise<unknown[]> {
  const data = await eb(`/aspsps?country=${encodeURIComponent(country)}`);
  const aspsps = Array.isArray(data?.aspsps) ? data.aspsps : [];
  return aspsps.map((a: any) => ({
    id: a.name, name: a.name, bic: a.bic ?? null, logo: a.logo ?? null,
    transaction_total_days: Number(a.maximum_consent_validity) || null,
  }));
}

async function createRequisition(req: Request, userId: string, organizationId: string, body: Record<string, unknown>) {
  const aspspName = String(body.institutionId || '').trim(); // Enable Banking gebruikt de naam als id
  const institutionName = body.institutionName ? String(body.institutionName) : aspspName;
  const redirectUrl = String(body.redirectUrl || '').trim();
  if (!aspspName) throw new HttpError('Kies een bank.', 400);
  assertRedirectAllowed(req, redirectUrl);

  const state = crypto.randomUUID();
  const validUntil = new Date(Date.now() + EB_CONSENT_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const auth = await eb('/auth', {
    method: 'POST',
    body: JSON.stringify({
      access: { valid_until: validUntil },
      aspsp: { name: aspspName, country: EB_COUNTRY },
      redirect_url: redirectUrl,
      state,
      psu_type: EB_PSU_TYPE,
    }),
  });
  if (!auth?.url) throw new HttpError('Enable Banking gaf geen koppel-link terug.', 502);

  const { error } = await supabaseAdmin.from('bank_requisitions').insert({
    organization_id: organizationId, created_by: userId, provider: 'enablebanking',
    institution_id: aspspName, institution_name: institutionName, institution_country: EB_COUNTRY,
    reference: state, link: auth.url, status: 'created', expires_at: validUntil,
  });
  if (error) throw new HttpError(`Kon de koppeling niet vastleggen: ${error.message}`, 500);

  return { link: auth.url as string, reference: state };
}

async function finalizeRequisition(userId: string, code: string, state: string) {
  if (!code || !state) throw new HttpError('Ontbrekende autorisatiecode of state.', 400);
  const { data: reqRow, error: reqErr } = await supabaseAdmin
    .from('bank_requisitions').select('*').eq('reference', state).limit(1).maybeSingle();
  if (reqErr) throw new HttpError(`Requisition-lookup mislukt: ${reqErr.message}`, 500);
  if (!reqRow) throw new HttpError('Koppeling niet gevonden.', 404);

  const organizationId = reqRow.organization_id as string;
  const role = await requireOrganizationAccess(userId, organizationId);
  if (!['owner', 'admin', 'member'].includes(role)) throw new HttpError('Geen schrijfrechten voor deze organisatie.', 403);

  let session: any;
  try {
    session = await eb('/sessions', { method: 'POST', body: JSON.stringify({ code }) });
  } catch (e) {
    await supabaseAdmin.from('bank_requisitions').update({ status: 'error', error: describeError(e) }).eq('id', reqRow.id);
    throw e;
  }

  const rawAccounts: any[] = Array.isArray(session?.accounts) ? session.accounts : [];
  const sessionId = session?.session_id || null;
  if (rawAccounts.length === 0) {
    await supabaseAdmin.from('bank_requisitions').update({ status: 'error', error: 'Geen rekeningen ontvangen.' }).eq('id', reqRow.id);
    return { status: 'error', linked: 0, imported: 0 };
  }

  const ledgerAccountId = await defaultBankLedgerAccount(organizationId);
  const accountUids: string[] = [];
  let linked = 0;

  for (const acc of rawAccounts) {
    const uid = typeof acc === 'string' ? acc : acc?.uid;
    if (!uid) continue;
    accountUids.push(uid);

    let iban: string | null = (typeof acc === 'object' ? (acc?.account_id?.iban || acc?.iban) : null) || null;
    let name = reqRow.institution_name || 'Bankrekening';
    try {
      const details = await eb(`/accounts/${uid}/details`);
      iban = iban || details?.account_id?.iban || details?.iban || null;
      name = details?.name || details?.product || (iban ? `${reqRow.institution_name || 'Bank'} ${iban.slice(-4)}` : name);
    } catch { /* details optioneel */ }

    // Eerst op het externe account-id (deze rekening is al eens gekoppeld), dan op
    // IBAN. Die tweede stap is essentieel: zonder dat kreeg een rekening waarvan je
    // eerder afschriften had ingelezen bij het koppelen een TWEEDE rij, die op
    // dezelfde grootboekrekening (1100) boekt — waarmee elke transactie dubbel in
    // het banksaldo belandde.
    let existing: { id: string } | null = null;
    const byExternal = await supabaseAdmin.from('bank_accounts').select('id')
      .eq('organization_id', organizationId).eq('external_account_id', uid).limit(1).maybeSingle();
    existing = byExternal.data ?? null;
    if (!existing && iban) {
      const normalized = iban.replace(/\s+/g, '').toUpperCase();
      const { data: candidates } = await supabaseAdmin.from('bank_accounts')
        .select('id, iban, external_account_id').eq('organization_id', organizationId);
      const match = (candidates ?? []).find((c: { id: string; iban: string | null; external_account_id: string | null }) =>
        !c.external_account_id && (c.iban || '').replace(/\s+/g, '').toUpperCase() === normalized);
      if (match) existing = { id: match.id };
    }
    if (existing) {
      const { error: updErr } = await supabaseAdmin.from('bank_accounts').update({
        name, iban, provider: 'enablebanking', source: 'enablebanking',
        external_account_id: uid, bank_requisition_id: reqRow.id, is_active: true,
      }).eq('id', existing.id);
      if (!updErr) linked += 1;
    } else {
      const { error: insErr } = await supabaseAdmin.from('bank_accounts').insert({
        organization_id: organizationId, created_by: userId, name, iban, currency: 'EUR',
        ledger_account_id: ledgerAccountId, source: 'enablebanking', provider: 'enablebanking',
        external_account_id: uid, bank_requisition_id: reqRow.id, is_active: true,
      });
      if (!insErr) linked += 1;
    }
  }

  await supabaseAdmin.from('bank_requisitions').update({
    status: 'linked', requisition_id: sessionId, accounts: accountUids, linked_at: new Date().toISOString(), error: null,
  }).eq('id', reqRow.id);

  const synced = await syncAccounts(organizationId, null);
  const imported = synced.results.reduce((s, r) => s + (r.inserted || 0), 0);
  return { status: 'linked', linked, imported };
}

async function syncAccounts(organizationId: string, bankAccountId: string | null) {
  let query = supabaseAdmin.from('bank_accounts').select('*')
    .eq('organization_id', organizationId).eq('source', 'enablebanking').eq('is_active', true);
  if (bankAccountId) query = query.eq('id', bankAccountId);
  const { data: accounts, error } = await query;
  if (error) throw new HttpError(`Bankrekeningen ophalen mislukt: ${error.message}`, 500);
  if (!accounts || accounts.length === 0) return { results: [], needsReconsent: false };

  const results: Array<{ bankAccountId: string; inserted: number; skipped: number; error?: string }> = [];
  let needsReconsent = false;

  for (const acc of accounts) {
    if (!acc.external_account_id) { results.push({ bankAccountId: acc.id, inserted: 0, skipped: 0, error: 'geen extern account-id' }); continue; }
    const since = acc.last_synced_at
      ? new Date(new Date(acc.last_synced_at).getTime() - 7 * 24 * 60 * 60 * 1000)
      : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const dateFrom = since.toISOString().slice(0, 10);
    try {
      const raw: any[] = [];
      let continuationKey: string | null = null;
      let guard = 0;
      do {
        const qs = `?date_from=${dateFrom}` + (continuationKey ? `&continuation_key=${encodeURIComponent(continuationKey)}` : '');
        const resp = await eb(`/accounts/${acc.external_account_id}/transactions${qs}`);
        const batch = Array.isArray(resp?.transactions) ? resp.transactions : [];
        raw.push(...batch);
        continuationKey = resp?.continuation_key || null;
        guard += 1;
      } while (continuationKey && guard < 25);

      const txns = raw.map(mapEbTransaction).filter((t) => t.booking_date && t.amount_cents !== 0);
      const dates = txns.map((t) => t.booking_date).sort();
      const statement = {
        format: 'enablebanking', file_name: null, file_hash: null,
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
      const ebStatus = (e as any)?.ebStatus;
      if (ebStatus === 401 || ebStatus === 403) {
        needsReconsent = true;
        if (acc.bank_requisition_id) await supabaseAdmin.from('bank_requisitions').update({ status: 'expired' }).eq('id', acc.bank_requisition_id);
      }
      results.push({ bankAccountId: acc.id, inserted: 0, skipped: 0, error: describeError(e) });
    }
  }
  return { results, needsReconsent };
}

// ── Mapping + helpers ──────────────────────────────────────────────────────

function mapEbTransaction(tx: any) {
  const magnitude = Math.abs(Math.round((parseFloat(tx?.transaction_amount?.amount ?? '0') || 0) * 100));
  const indicator = String(tx?.credit_debit_indicator || '').toUpperCase();
  const cents = indicator === 'DBIT' ? -magnitude : magnitude;
  const id = tx?.entry_reference || tx?.transaction_id || null;
  const bookingDate = (tx?.booking_date || tx?.value_date || '').slice(0, 10) || null;
  const valueDate = (tx?.value_date || '').slice(0, 10) || null;
  const incoming = cents > 0;
  const counterpartyName = (incoming ? tx?.debtor?.name : tx?.creditor?.name) || null;
  const counterpartyIban = (incoming ? tx?.debtor_account?.iban : tx?.creditor_account?.iban) || null;
  const remittance = Array.isArray(tx?.remittance_information)
    ? tx.remittance_information.filter(Boolean).join(' ').trim()
    : (tx?.remittance_information || '');
  // Géén dedup_key meer: import_bank_transactions leidt die server-side af uit de
  // inhoud. Voorheen maakte deze functie `eb:`-sleutels terwijl de afschrift-import
  // `tx:`/`h:` gebruikte — dezelfde transactie via beide wegen gaf dus twee rijen.
  return {
    booking_date: bookingDate, value_date: valueDate, amount_cents: cents,
    currency: tx?.transaction_amount?.currency || 'EUR', counterparty_name: counterpartyName,
    counterparty_iban: counterpartyIban, description: remittance || null, structured_reference: null,
    end_to_end_id: null, bank_tx_id: id,
  };
}

async function defaultBankLedgerAccount(organizationId: string): Promise<string> {
  const { data: bySubtype } = await supabaseAdmin.from('ledger_accounts').select('id')
    .eq('organization_id', organizationId).eq('subtype', 'bank').limit(1);
  const { data: byCode } = await supabaseAdmin.from('ledger_accounts').select('id')
    .eq('organization_id', organizationId).eq('code', '1100').limit(1);
  const id = bySubtype?.[0]?.id || byCode?.[0]?.id;
  if (!id) throw new HttpError('Geen bank-grootboekrekening (1100) gevonden. Richt eerst je rekeningschema in.', 422);
  return id as string;
}

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlStr(str: string): string { return b64url(new TextEncoder().encode(str)); }
function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '').replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
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
function parsePositiveInt(value: string | null | undefined, fallback: number): number { const n = Number.parseInt(String(value ?? ''), 10); return Number.isFinite(n) && n > 0 ? n : fallback; }
function requiredEnv(name: string): string { const value = Deno.env.get(name); if (!value) throw new Error(`Missing required env var: ${name}`); return value; }
