import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { assertModuleAccess } from '../_shared/edgeAuth.ts';
import {
  bankReturnError, choosePsuType, consentExpired, consentValidUntil, ebErrorCode, isBookedTransaction,
  mapAspsp, mapEbTransaction, needsReconsent, psuTypesOf, syncDateFrom, type PsuType,
} from '../_shared/bankSync.ts';

// ============================================================
// bank-sync — directe PSD2-bankkoppeling via Enable Banking (EU/Fins AISP).
//
// Acties (POST, met Supabase bearer token van een organisatielid):
//  - listInstitutions   : banken (ASPSP's) voor de bankkiezer (lezen, elk lid)
//  - createRequisition  : start consent; geeft de redirect-link terug (schrijfrol)
//  - finalizeRequisition: na de redirect (?code=&state=); koppelt rekeningen + 1e sync.
//                         Ook bij ?error=&state= (afgebroken/geweigerd): legt dat vast.
//  - sync               : nieuwe transacties ophalen voor 1/alle rekeningen (schrijfrol)
//
// Cron (POST ?cron=sync, header x-cron-secret): haalt voor elke gekoppelde rekening
// met een geldige toestemming één keer per dag de nieuwe transacties op.
//
// Auth richting Enable Banking: een JWT (RS256), gesigneerd met de private sleutel
// (ENABLEBANKING_PRIVATE_KEY, PKCS#8 PEM) en kid = ENABLEBANKING_APP_ID. App-breed
// (de app is de TPP). Per organisatie bewaren we alleen requisitions + gekoppelde
// rekeningen. Schrijven met de service-role, dus de import-RPC ziet
// auth.role()='service_role' en slaat de can_write_org-check over.
// ============================================================

type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer' | 'accountant';
type HttpStatus = 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502;

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
const EB_APP_ID = Deno.env.get('ENABLEBANKING_APP_ID') || '';
const EB_PRIVATE_KEY = (Deno.env.get('ENABLEBANKING_PRIVATE_KEY') || '').replace(/\\n/g, '\n');
const EB_BASE_URL = (Deno.env.get('ENABLEBANKING_BASE_URL') || 'https://api.enablebanking.com').replace(/\/$/, '');
const EB_COUNTRY = (Deno.env.get('ENABLEBANKING_COUNTRY') || 'NL').toUpperCase();
const EB_PSU_TYPE: PsuType = (Deno.env.get('ENABLEBANKING_PSU_TYPE') || '').toLowerCase() === 'personal' ? 'personal' : 'business';
// Leeg = het maximum dat de bank toestaat (meestal 180 dagen); ingesteld = bovengrens.
const EB_CONSENT_DAYS = parsePositiveInt(Deno.env.get('ENABLEBANKING_CONSENT_DAYS'), 0) || null;
// Valt terug op het secret van de factuurherinneringen, net als invoice-inbox: dan
// hoeft er voor de automatische sync niets nieuws gezet te worden.
const BANK_SYNC_CRON_SECRET = Deno.env.get('BANK_SYNC_CRON_SECRET') || Deno.env.get('INVOICE_REMINDER_CRON_SECRET') || '';
const BANK_SYNC_CRON_BATCH = parsePositiveInt(Deno.env.get('BANK_SYNC_CRON_BATCH'), 20);
// Eén keer per dag per rekening. PSD2 staat zonder de klant erbij maar vier
// opvragingen per dag toe, en vaker levert bij een boekhouding niets op.
const AUTO_SYNC_EVERY_HOURS = 20;
// Paginering van de transacties: ruim genoeg voor 90 dagen van een drukke
// rekening. Komt een sync er niet doorheen, dan telt hij niet als gelukt en gaat
// de volgende verder (zie syncOneAccount).
const MAX_TRANSACTION_PAGES = 100;
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
  // pg_cron stuurt geen Origin mee; het cron-secret is hier de toegangscontrole.
  const cron = new URL(req.url).searchParams.get('cron');
  if (cron) return await handleCron(req, cron);
  try {
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Method not allowed.' }, 405);
    assertAllowedOrigin(req);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || '');
    const user = await requireUser(req);

    // finalize leidt de organisatie af uit de requisition (state), niet uit de body.
    if (action === 'finalizeRequisition') {
      return json(req, { ok: true, ...(await finalizeRequisition(user.id, body)) });
    }

    const organizationId = String(body.organizationId || '');
    const role = await requireOrganizationAccess(user.id, organizationId);

    if (action === 'listInstitutions') {
      return json(req, { ok: true, institutions: await listInstitutions(String(body.country || '') || EB_COUNTRY) });
    }

    if (!['owner', 'admin', 'member'].includes(role)) throw new HttpError('Geen schrijfrechten voor deze organisatie.', 403);
    // Service-role omzeilt RLS: bankkoppelingen vallen onder Financiën, dus die
    // module moet ook echt openstaan voor dit teamlid.
    await assertModuleAccess(supabaseAdmin, user.id, organizationId, 'finance', 'write');

    switch (action) {
      case 'createRequisition':
        return json(req, { ok: true, ...(await createRequisition(req, user.id, organizationId, body)) });
      case 'sync':
        return json(req, { ok: true, ...(await syncAccounts(organizationId, { bankAccountId: body.bankAccountId ? String(body.bankAccountId) : null })) });
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
    const code = ebErrorCode(data);
    const detail = data?.message || data?.detail || data?.error || text.slice(0, 200);
    // Altijd 502 naar de app: een 401 van Enable Banking betekent dat de provider
    // óns weigert (sleutel, verlopen sessie), niet dat de gebruiker niet is ingelogd.
    const err = new HttpError(`Enable Banking-fout (${res.status}${code && !String(detail).includes(code) ? ` ${code}` : ''}): ${detail || 'onbekend'}`, 502);
    (err as any).ebStatus = res.status;
    (err as any).ebCode = code;
    throw err;
  }
  return data;
}

// De bankenlijst verandert zelden; even bewaren scheelt een tweede opvraging als
// iemand de bankkiezer opent en daarna een bank kiest.
const aspspCache = new Map<string, { at: number; list: any[] }>();
async function rawAspsps(country: string): Promise<any[]> {
  const cached = aspspCache.get(country);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.list;
  const data = await eb(`/aspsps?country=${encodeURIComponent(country)}`);
  const list = Array.isArray(data?.aspsps) ? data.aspsps : [];
  aspspCache.set(country, { at: Date.now(), list });
  return list;
}

// ── Acties ───────────────────────────────────────────────────────────────

async function listInstitutions(country: string): Promise<unknown[]> {
  return (await rawAspsps(country)).map(mapAspsp).filter(Boolean);
}

async function createRequisition(req: Request, userId: string, organizationId: string, body: Record<string, unknown>) {
  const aspspName = String(body.institutionId || '').trim(); // Enable Banking gebruikt de naam als id
  const institutionName = body.institutionName ? String(body.institutionName) : aspspName;
  const redirectUrl = String(body.redirectUrl || '').trim();
  if (!aspspName) throw new HttpError('Kies een bank.', 400);
  assertRedirectAllowed(req, redirectUrl);

  // De bank bepaalt welke rekeningsoorten de koppeling aankan en hoe lang een
  // toestemming mag gelden. Gaan we daar overheen, dan weigert Enable Banking de
  // hele koppeling — dus eerst kijken in plaats van vaste waarden sturen.
  const aspsp = (await rawAspsps(EB_COUNTRY)).find((a: any) => a?.name === aspspName);
  if (!aspsp) throw new HttpError('Deze bank staat niet (meer) in de bankenlijst. Kies je bank opnieuw.', 400);
  const psuType = choosePsuType(body.psuType, psuTypesOf(aspsp.psu_types), EB_PSU_TYPE);
  if (!psuType) {
    throw new HttpError(body.psuType === 'personal'
      ? 'Deze bank kan via de koppeling geen privérekeningen koppelen. Kies "Zakelijke rekening".'
      : 'Deze bank kan via de koppeling geen zakelijke rekeningen koppelen. Kies "Privérekening".', 400);
  }

  const state = crypto.randomUUID();
  const validUntil = consentValidUntil(Date.now(), aspsp.maximum_consent_validity, EB_CONSENT_DAYS);
  const auth = await eb('/auth', {
    method: 'POST',
    body: JSON.stringify({
      access: { valid_until: validUntil },
      aspsp: { name: aspspName, country: EB_COUNTRY },
      redirect_url: redirectUrl,
      state,
      psu_type: psuType,
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

async function finalizeRequisition(userId: string, body: Record<string, unknown>) {
  const code = String(body.code || '').trim();
  const state = String(body.state || '').trim();
  const returnError = String(body.error || '').trim();
  if (!state || (!code && !returnError)) throw new HttpError('Ontbrekende autorisatiecode of state.', 400);
  const { data: reqRow, error: reqErr } = await supabaseAdmin
    .from('bank_requisitions').select('*').eq('reference', state).limit(1).maybeSingle();
  if (reqErr) throw new HttpError(`Requisition-lookup mislukt: ${reqErr.message}`, 500);
  if (!reqRow) throw new HttpError('Koppeling niet gevonden.', 404);

  const organizationId = reqRow.organization_id as string;
  const role = await requireOrganizationAccess(userId, organizationId);
  if (!['owner', 'admin', 'member'].includes(role)) throw new HttpError('Geen schrijfrechten voor deze organisatie.', 403);
  // Service-role omzeilt RLS: bankkoppelingen vallen onder Financiën, dus die
  // module moet ook echt openstaan voor dit teamlid.
  await assertModuleAccess(supabaseAdmin, userId, organizationId, 'finance', 'write');

  // Terug met ?error= in plaats van ?code=: afgebroken bij de bank of door de
  // bank geweigerd. Voorheen bleef zo'n koppeling stil op "created" staan en zag
  // niemand waarom het niet lukte.
  if (!code) {
    const outcome = bankReturnError(returnError, String(body.errorDescription || ''));
    if (reqRow.status === 'created') {
      await supabaseAdmin.from('bank_requisitions').update({ status: 'error', error: outcome.detail }).eq('id', reqRow.id);
    }
    return { status: outcome.status, linked: 0, imported: 0, error: outcome.detail };
  }
  // Een code is maar één keer in te wisselen; een tweede afronding (dubbel
  // geladen pagina) zou de geslaagde koppeling anders als mislukt markeren.
  if (reqRow.status === 'linked') return { status: 'linked', linked: 0, imported: 0, alreadyLinked: true };

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
    return {
      status: 'error', linked: 0, imported: 0,
      error: 'De bank gaf geen rekeningen door. Kies bij de bank minstens één rekening om te delen, of controleer of je de juiste rekeningsoort (zakelijk/privé) koos.',
    };
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
      const sameIban = (candidates ?? []).filter((c: { id: string; iban: string | null; external_account_id: string | null }) =>
        (c.iban || '').replace(/\s+/g, '').toUpperCase() === normalized);
      // Een IBAN is wereldwijd uniek, dus een rij met deze IBAN ís deze rekening.
      // Bij voorkeur een rij die nog nooit gekoppeld was (de klassieke
      // import→koppel-samenvoeging); anders een rij met een ANDER extern id — dat
      // is het herkoppel-geval: na het verlopen van de toestemming geeft Enable
      // Banking vaak een nieuw account-uid uit. Zouden we die overslaan, dan komt
      // er een tweede rij met dezelfde IBAN die óók op 1100 boekt, en is de
      // dubbeltelling alleen maar verschoven van "import→koppel" naar "herkoppel".
      const match = sameIban.find(c => !c.external_account_id) ?? sameIban[0];
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

  // De bank kan de toestemming korter maken dan we vroegen; de sessie zegt hoe
  // lang hij echt geldt, en daarop rekenen de verloopwaarschuwingen.
  const grantedUntil = Date.parse(String(session?.access?.valid_until ?? ''));
  await supabaseAdmin.from('bank_requisitions').update({
    status: 'linked', requisition_id: sessionId, accounts: accountUids, linked_at: new Date().toISOString(), error: null,
    ...(Number.isFinite(grantedUntil) ? { expires_at: new Date(grantedUntil).toISOString() } : {}),
  }).eq('id', reqRow.id);

  // Alleen de rekeningen van déze koppeling: de rest van de organisatie heeft
  // zijn eigen toestemming (die misschien al verlopen is) en zijn eigen ritme.
  const synced = await syncAccounts(organizationId, { requisitionId: reqRow.id });
  const imported = synced.results.reduce((s, r) => s + (r.inserted || 0), 0);
  // Koppelen gelukt maar ophalen niet? Dan moet de gebruiker dat zien, niet
  // "0 transacties opgehaald" alsof er niets was.
  const failed = synced.results.filter((r) => r.error);
  return { status: 'linked', linked, imported, syncErrors: failed.length, syncError: failed[0]?.error ?? null };
}

type SyncResult = { bankAccountId: string; inserted: number; skipped: number; error?: string };
type RequisitionState = { id: string; status: string; expires_at: string | null; organization_id: string; accounts: unknown };

async function syncAccounts(organizationId: string, filter: { bankAccountId?: string | null; requisitionId?: string | null } = {}) {
  let query = supabaseAdmin.from('bank_accounts').select('*')
    .eq('organization_id', organizationId).eq('source', 'enablebanking').eq('is_active', true);
  if (filter.bankAccountId) query = query.eq('id', filter.bankAccountId);
  if (filter.requisitionId) query = query.eq('bank_requisition_id', filter.requisitionId);
  const { data: accounts, error } = await query;
  if (error) throw new HttpError(`Bankrekeningen ophalen mislukt: ${error.message}`, 500);
  return syncAccountRows(accounts ?? []);
}

/** De gegeven rekeningen bijwerken. Elke rij draagt zijn eigen organisatie, dus de cron gebruikt dit ook. */
async function syncAccountRows(accounts: any[]): Promise<{ results: SyncResult[]; needsReconsent: boolean }> {
  if (accounts.length === 0) return { results: [], needsReconsent: false };
  const requisitionIds = [...new Set(accounts.map((a) => a.bank_requisition_id).filter(Boolean))];
  const requisitions = new Map<string, RequisitionState>();
  if (requisitionIds.length > 0) {
    const { data, error } = await supabaseAdmin.from('bank_requisitions').select('id, status, expires_at, organization_id, accounts').in('id', requisitionIds);
    if (error) throw new HttpError(`Bankkoppelingen ophalen mislukt: ${error.message}`, 500);
    for (const r of data ?? []) requisitions.set(r.id, r);
  }

  const results: SyncResult[] = [];
  let reconsentNeeded = false;
  for (const acc of accounts) {
    const { result, reconsent } = await syncOneAccount(acc, requisitions.get(acc.bank_requisition_id) ?? null);
    results.push(result);
    if (reconsent) reconsentNeeded = true;
  }
  return { results, needsReconsent: reconsentNeeded };
}

/** Hoort deze rekening bij deze koppeling: dezelfde organisatie, en het id in de lijst van de bank? */
function requisitionCoversAccount(requisition: RequisitionState | null, acc: { organization_id?: string; external_account_id?: string | null }): boolean {
  if (!requisition || !acc.external_account_id) return false;
  if (requisition.organization_id !== acc.organization_id) return false;
  return Array.isArray(requisition.accounts) && requisition.accounts.includes(acc.external_account_id);
}

async function syncOneAccount(acc: any, requisition: RequisitionState | null): Promise<{ result: SyncResult; reconsent: boolean }> {
  const fail = async (error: string, reconsent = false) => {
    await markSyncFailed(acc.id, error);
    return { result: { bankAccountId: acc.id, inserted: 0, skipped: 0, error }, reconsent };
  };
  if (!acc.external_account_id) return fail('geen extern account-id');
  // Eén Enable Banking-app voor alle organisaties: het account-id is de enige
  // sleutel tot de transacties. De rekening telt daarom alleen als hij bij een
  // koppeling van dezelfde organisatie hoort die dit id van de bank kreeg.
  // Zonder die controle kon een teamlid het id van de rekening van een ander
  // bedrijf in een eigen rij zetten en diens transacties binnenhalen.
  if (!requisitionCoversAccount(requisition, acc)) {
    return fail('Deze rekening hoort niet bij een bankkoppeling van deze organisatie. Koppel de bank opnieuw.', true);
  }
  // De verloopdatum staat vast vanaf het koppelen. Voorheen kwam "verlopen" pas
  // aan het licht als een opvraging mislukte — en zonder opvraging nooit: de
  // koppelingen op staging stonden maanden na het verlopen nog op "gekoppeld".
  if (consentExpired(requisition, Date.now())) {
    if (requisition && requisition.status !== 'expired') {
      await supabaseAdmin.from('bank_requisitions').update({ status: 'expired' }).eq('id', requisition.id);
    }
    return fail('De toestemming bij de bank is verlopen. Koppel de bank opnieuw.', true);
  }

  const dateFrom = syncDateFrom(acc.last_synced_at, Date.now());
  try {
    const fetched = await fetchTransactions(acc.external_account_id, dateFrom);
    const txns = fetched.transactions.filter(isBookedTransaction).map(mapEbTransaction)
      .filter((t) => t.booking_date && t.amount_cents !== 0 && (!fetched.longest || t.booking_date >= dateFrom));
    const dates = txns.map((t) => t.booking_date as string).sort();
    const statement = {
      format: 'enablebanking', file_name: null, file_hash: null,
      period_start: dates[0] ?? null, period_end: dates[dates.length - 1] ?? null,
      opening_balance_cents: null, closing_balance_cents: null,
    };
    let inserted = 0, skipped = 0;
    if (txns.length > 0) {
      const { data: imp, error: impErr } = await supabaseAdmin.rpc('import_bank_transactions', {
        p_organization_id: acc.organization_id, p_bank_account_id: acc.id, p_statement: statement, p_transactions: txns,
      });
      if (impErr) throw new Error(impErr.message);
      inserted = (imp as any)?.inserted ?? 0; skipped = (imp as any)?.skipped ?? 0;
    }
    if (!fetched.complete) {
      // Niet als gesynct markeren: de volgende sync begint dan weer bij dezelfde
      // datum en vult het gat; wat al binnen is, wordt ontdubbeld.
      const error = `Niet alle transacties opgehaald (meer dan ${MAX_TRANSACTION_PAGES} pagina's). De volgende synchronisatie gaat verder.`;
      await markSyncFailed(acc.id, error);
      return { result: { bankAccountId: acc.id, inserted, skipped, error }, reconsent: false };
    }
    await markSynced(acc.id);
    return { result: { bankAccountId: acc.id, inserted, skipped }, reconsent: false };
  } catch (e) {
    const reconsent = needsReconsent((e as any)?.ebStatus, (e as any)?.ebCode ?? null);
    if (reconsent && acc.bank_requisition_id) {
      await supabaseAdmin.from('bank_requisitions').update({ status: 'expired' }).eq('id', acc.bank_requisition_id);
    }
    return fail(describeError(e), reconsent);
  }
}

/**
 * Alle transacties vanaf dateFrom, met paginering. Sommige banken geven niet de
 * hele gevraagde periode vrij en antwoorden dan WRONG_TRANSACTIONS_PERIOD; de
 * strategie "longest" zoekt zelf de vroegste beschikbare datum (zonder die
 * fout). Daarvan houden we alleen wat in ons venster valt.
 */
async function fetchTransactions(accountUid: string, dateFrom: string): Promise<{ transactions: any[]; complete: boolean; longest: boolean }> {
  try {
    return { ...(await pageTransactions(accountUid, `date_from=${dateFrom}`)), longest: false };
  } catch (e) {
    const code = (e as any)?.ebCode || '';
    if (code !== 'WRONG_TRANSACTIONS_PERIOD' && !describeError(e).includes('WRONG_TRANSACTIONS_PERIOD')) throw e;
    return { ...(await pageTransactions(accountUid, `date_from=${dateFrom}&strategy=longest`)), longest: true };
  }
}

async function pageTransactions(accountUid: string, query: string): Promise<{ transactions: any[]; complete: boolean }> {
  const transactions: any[] = [];
  let continuationKey: string | null = null;
  let pages = 0;
  do {
    const qs = `?${query}` + (continuationKey ? `&continuation_key=${encodeURIComponent(continuationKey)}` : '');
    const resp = await eb(`/accounts/${encodeURIComponent(accountUid)}/transactions${qs}`);
    if (Array.isArray(resp?.transactions)) transactions.push(...resp.transactions);
    continuationKey = resp?.continuation_key || null;
    pages += 1;
  } while (continuationKey && pages < MAX_TRANSACTION_PAGES);
  return { transactions, complete: !continuationKey };
}

/**
 * Een geslaagde sync. Zonder migratie 20261030000000 bestaan de kolommen voor
 * de cron nog niet; dan alleen last_synced_at, zoals voorheen.
 */
async function markSynced(accountId: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin.from('bank_accounts')
    .update({ last_synced_at: now, last_sync_attempt_at: now, last_sync_error: null }).eq('id', accountId);
  if (error) await supabaseAdmin.from('bank_accounts').update({ last_synced_at: now }).eq('id', accountId);
}

/** Een mislukte poging: wanneer en waarom, zodat de bankpagina het laat zien (zonder de kolommen: niets). */
async function markSyncFailed(accountId: string, message: string): Promise<void> {
  await supabaseAdmin.from('bank_accounts')
    .update({ last_sync_attempt_at: new Date().toISOString(), last_sync_error: message.slice(0, 500) }).eq('id', accountId);
}

// ── Cron: automatisch synchroniseren ─────────────────────────────────────────

async function handleCron(req: Request, cron: string): Promise<Response> {
  const reply = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  if (!BANK_SYNC_CRON_SECRET) return reply({ ok: false, error: 'BANK_SYNC_CRON_SECRET (of INVOICE_REMINDER_CRON_SECRET) ontbreekt in de Edge Function secrets.' }, 500);
  if (!timingSafeEqual(req.headers.get('x-cron-secret') || '', BANK_SYNC_CRON_SECRET)) return reply({ ok: false, error: 'Ongeldig of ontbrekend cron-secret.' }, 401);
  if (cron !== 'sync') return reply({ ok: false, error: `Onbekende cron: ${cron}` }, 400);
  try {
    return reply({ ok: true, ...(await autoSync()) });
  } catch (e) {
    console.error('bank-sync cron error', describeError(e));
    return reply({ ok: false, error: 'Automatische banksync mislukt door een serverfout.' }, 500);
  }
}

/**
 * Eén ronde: de rekeningen met een geldige toestemming die het langst niet aan
 * de beurt waren, hooguit BANK_SYNC_CRON_BATCH per keer. Elk uur een ronde
 * (ENABLEBANKING_BANK_SYNC_SETUP_2026-06-25.md) houdt elke rekening dagelijks
 * bij, ook met veel klanten.
 * Verlopen toestemmingen vallen er via de join uit; die wachten op de klant.
 */
async function autoSync() {
  const nowIso = new Date().toISOString();
  const dueBefore = new Date(Date.now() - AUTO_SYNC_EVERY_HOURS * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin.from('bank_accounts')
    .select('*, bank_requisitions!inner(id, status, expires_at)')
    .eq('source', 'enablebanking').eq('is_active', true).not('external_account_id', 'is', null)
    .eq('bank_requisitions.status', 'linked').gt('bank_requisitions.expires_at', nowIso)
    .or(`last_sync_attempt_at.is.null,last_sync_attempt_at.lt."${dueBefore}"`)
    .order('last_sync_attempt_at', { ascending: true, nullsFirst: true })
    .limit(BANK_SYNC_CRON_BATCH);
  if (error) throw new Error(`Rekeningen voor de automatische sync ophalen mislukt: ${error.message}`);
  const accounts = (data ?? []).map(({ bank_requisitions: _requisition, ...account }: any) => account);
  const { results } = await syncAccountRows(accounts);
  const failed = results.filter((r) => r.error);
  for (const r of failed) console.warn('bank-sync cron: rekening niet bijgewerkt', r.bankAccountId, r.error);
  return {
    checked: accounts.length,
    synced: results.length - failed.length,
    failed: failed.length,
    inserted: results.reduce((s, r) => s + (r.inserted || 0), 0),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
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
    ? origin : BANK_ALLOW_LOCAL_DEV && !origin ? '*' : '';
  return { ...(allowOrigin ? { 'Access-Control-Allow-Origin': allowOrigin } : {}), 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin' };
}
function json(req: Request, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } });
}
function assertAllowedOrigin(req: Request): void {
  const origin = req.headers.get('origin') || '';
  // Een pagina zonder herkomst (sandbox-iframe, data:, file:) is nooit de app.
  if (origin === 'null') throw new HttpError('Verzoeken zonder herkomst (origin "null") worden niet geaccepteerd.', 403);
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
