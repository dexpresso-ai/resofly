import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { assertModuleAccess } from '../_shared/edgeAuth.ts';
import {
  addDays, amsterdamDate, classifyEbError, consentValidUntil, dateSlices, fetchAllTransactionPages,
  pickBookedBalance, prepareEbTransactions, psuHeaders, retryAfter, sessionState, settledThrough, SLICE_DAYS, sliceDaysOf, syncWindow,
  type EbErrorKind, type MappedBankTransaction, type PsuHeaders,
} from '../_shared/enableBanking.ts';

// ============================================================
// bank-sync — directe PSD2-bankkoppeling via Enable Banking (EU/Fins AISP).
//
// Acties (POST, met Supabase bearer token van een organisatielid):
//  - listInstitutions   : banken (ASPSP's) voor de bankkiezer (lezen, elk lid)
//  - createRequisition  : start consent; geeft de redirect-link terug (schrijfrol)
//  - finalizeRequisition: na de redirect (?code=&state=); koppelt rekeningen + 1e sync
//  - sync               : nieuwe transacties + het geboekte saldo ophalen voor
//                         1/alle rekeningen (schrijfrol)
//
// En zonder gebruiker: POST ?cron=sync met x-cron-secret = BANK_SYNC_CRON_SECRET
// (pg_cron + pg_net, elk uur). Markeert verlopen toestemmingen en haalt de
// gekoppelde rekeningen op die aan de beurt zijn — langst niet opgehaald eerst,
// hoogstens elke twaalf uur, binnen een tijdsbudget per aanroep.
//
// Is de gebruiker er zelf bij, dan gaan zijn IP en user-agent mee als
// PSU-headers: de bank telt die opvraging dan niet mee voor de PSD2-grens van
// vier keer per 24 uur op de achtergrond, die de geplande sync nodig heeft.
//
// Auth richting Enable Banking: een JWT (RS256), gesigneerd met de private sleutel
// (ENABLEBANKING_PRIVATE_KEY, PKCS#8 PEM) en kid = ENABLEBANKING_APP_ID. App-breed
// (de app is de TPP). Per organisatie bewaren we alleen requisitions + gekoppelde
// rekeningen. Schrijven met de service-role, dus de import-RPC ziet
// auth.role()='service_role' en slaat de can_write_org-check over.
// ============================================================

type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer' | 'accountant';
type HttpStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502;

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
const EB_APP_ID = Deno.env.get('ENABLEBANKING_APP_ID') || '';
const EB_PRIVATE_KEY = (Deno.env.get('ENABLEBANKING_PRIVATE_KEY') || '').replace(/\\n/g, '\n');
const EB_BASE_URL = (Deno.env.get('ENABLEBANKING_BASE_URL') || 'https://api.enablebanking.com').replace(/\/$/, '');
const EB_COUNTRY = (Deno.env.get('ENABLEBANKING_COUNTRY') || 'NL').toUpperCase();
const EB_PSU_TYPE = (Deno.env.get('ENABLEBANKING_PSU_TYPE') || 'business').toLowerCase();
// Hoe lang een toestemming loopt: de PSD2-RTS staat sinds juli 2023 180 dagen toe;
// per bank begrensd door wat die toestaat (maximum_consent_validity).
const EB_CONSENT_DAYS = parsePositiveInt(Deno.env.get('ENABLEBANKING_CONSENT_DAYS'), 180);
const BANK_SYNC_CRON_SECRET = Deno.env.get('BANK_SYNC_CRON_SECRET') || '';
// Ruim binnen de wandklok van een edge function (150 s): wat niet past, komt het
// volgende uur aan de beurt.
const CRON_TIME_BUDGET_MS = 100_000;
const MANUAL_TIME_BUDGET_MS = 110_000;
// Per rekening in de geplande ronde: één trage bank mag de rest niet opeten.
const CRON_PER_ACCOUNT_MS = 40_000;
// Had een rekening minstens zoveel tijd en paste één stuk er niet in, dan is het
// stuk te groot (en niet de ronde bijna om): de volgende keer de helft.
const MIN_SLICE_BUDGET_MS = 30_000;
const HOUR_MS = 60 * 60 * 1000;
// Op de achtergrond hoogstens twee keer per dag per rekening: een sync vraagt
// transacties én saldo op, en de bank staat zonder gebruiker vier opvragingen per
// 24 uur toe.
const SCHEDULED_SYNC_INTERVAL = '12 hours';
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

/**
 * Een fout van Enable Banking, met wat hij betekent voor de gebruiker. `message`
 * is voor de gebruiker; `detail` (status, pad, melding van de bank) voor de logs.
 */
class EbError extends HttpError {
  ebStatus: number;
  kind: EbErrorKind | 'config';
  detail: string;
  constructor(message: string, status: HttpStatus, ebStatus: number, kind: EbErrorKind | 'config', detail: string) {
    super(message, status); this.name = 'EbError'; this.ebStatus = ebStatus; this.kind = kind; this.detail = detail;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return json(req, { ok: true });
  try {
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Method not allowed.' }, 405);

    // Machine-to-machine ingang voor de geplande sync (pg_cron + pg_net), met een
    // gedeeld secret in plaats van een gebruikerssessie — dus vóór de origin-check,
    // net als de crons van invoice-workflow.
    if (new URL(req.url).searchParams.get('cron') === 'sync') return await handleSyncCron(req);

    assertAllowedOrigin(req);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || '');
    const user = await requireUser(req);
    // De gebruiker is erbij: zijn IP en browser gaan mee naar de bank.
    const psu = psuHeaders(req.headers, req.headers.get('user-agent'));
    const deadline = Date.now() + MANUAL_TIME_BUDGET_MS;

    // finalize leidt de organisatie af uit de requisition (state), niet uit de body.
    if (action === 'finalizeRequisition') {
      return json(req, { ok: true, ...(await finalizeRequisition(user.id, String(body.code || ''), String(body.state || ''), psu, deadline)) });
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
        return json(req, { ok: true, ...(await createRequisition(req, user.id, organizationId, body, psu)) });
      case 'sync':
        return json(req, { ok: true, ...(await syncAccounts(organizationId, body.bankAccountId ? String(body.bankAccountId) : null, { psu, deadline })) });
      default:
        return json(req, { ok: false, error: `Onbekende bank-sync action: ${action}` }, 400);
    }
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const internal = error instanceof EbError ? `${error.message} [${error.detail}]` : describeError(error);
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

async function eb(path: string, init?: RequestInit, psu: PsuHeaders = {}): Promise<any> {
  const token = await ebJwt();
  let res: Response;
  try {
    res = await fetch(`${EB_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json',
        ...psu, ...(init?.headers || {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new EbError(ebMessage('bank_unavailable', 0, ''), 502, 0, 'bank_unavailable', `geen antwoord op ${path}: ${describeError(e)}`);
  }
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const detail = String(data?.message || data?.detail || data?.error || text.slice(0, 200) || 'onbekend');
    const kind = classifyEbError(res.status, data?.raw ?? data);
    throw new EbError(ebMessage(kind, res.status, detail), kind === 'rate_limited' ? 429 : 502, res.status, kind,
      `${res.status} op ${path.split('?')[0]}: ${detail}`);
  }
  return data;
}

/** Wat de gebruiker te zien krijgt; de technische details staan in de logs. */
function ebMessage(kind: EbErrorKind | 'config', status: number, detail: string): string {
  switch (kind) {
    case 'reconsent':
    case 'auth':
      return 'De toestemming voor deze bankrekening is verlopen of ingetrokken. Koppel de rekening opnieuw.';
    case 'account':
      return 'De bank geeft deze rekening nu niet vrij, terwijl de toestemming nog geldig is. Is de rekening opgeheven, zet hem dan op inactief; anders proberen we het later opnieuw.';
    case 'config':
      return 'De bankkoppeling van ResoFly zelf is niet goed ingesteld (Enable Banking-sleutel of app). Dit ligt niet aan je bank; de beheerder moet het oplossen.';
    case 'rate_limited':
      return 'De bank staat nu even geen nieuwe opvraging toe. Probeer het over een uur opnieuw; de automatische synchronisatie haalt het vanzelf in.';
    case 'bank_unavailable':
      return 'De bank of Enable Banking reageert nu niet. Probeer het later opnieuw.';
    default:
      return `Enable Banking-fout (${status}): ${detail}`;
  }
}

/**
 * Een 401/403 bij het ophalen van één rekening kan drie dingen betekenen:
 *  - onze eigen sleutel of app klopt niet (GET /application geeft ook 401/403):
 *    configuratie — opnieuw koppelen helpt niet, en de toestemmingen blijven staan;
 *  - de sessie bij Enable Banking is beëindigd (GET /sessions/{id} met een
 *    eindstatus, of de sessie bestaat niet meer): opnieuw koppelen;
 *  - de sessie staat nog: dan gaat het om déze rekening (bv. opgeheven), en de
 *    andere rekeningen van dezelfde toestemming lopen gewoon door.
 * Is Enable Banking zelf even onbereikbaar, dan weten we het niet: tijdelijk.
 * De uitkomst van de sleutelcontrole wordt vijf minuten onthouden.
 */
let appCheck: { ok: boolean; at: number } | null = null;
async function resolveAuthError(err: EbError, sessionId: string | null): Promise<EbError> {
  if (err.kind !== 'auth') return err;
  const as = (kind: EbErrorKind | 'config') => new EbError(ebMessage(kind, err.ebStatus, ''), 502, err.ebStatus, kind, err.detail);
  if (!appCheck || Date.now() - appCheck.at > 5 * 60_000) {
    try {
      await eb('/application');
      appCheck = { ok: true, at: Date.now() };
    } catch (e) {
      const status = e instanceof EbError ? e.ebStatus : 0;
      if (status !== 401 && status !== 403) return as('bank_unavailable');
      appCheck = { ok: false, at: Date.now() };
    }
  }
  if (!appCheck.ok) return as('config');
  if (!sessionId) return as('account');
  try {
    const session = await eb(`/sessions/${encodeURIComponent(sessionId)}`);
    return as(sessionState(session) === 'ended' ? 'reconsent' : 'account');
  } catch (e) {
    if (e instanceof EbError && (e.kind === 'reconsent' || e.ebStatus === 404)) return as('reconsent');
    return as('bank_unavailable');
  }
}

/** Een aanroep die niet aan een toestemming hangt: een 401/403 is dan onze eigen sleutel. */
async function ebApp(path: string, init?: RequestInit, psu: PsuHeaders = {}): Promise<any> {
  try {
    return await eb(path, init, psu);
  } catch (e) {
    if (e instanceof EbError && e.kind === 'auth') throw new EbError(ebMessage('config', e.ebStatus, ''), 502, e.ebStatus, 'config', e.detail);
    throw e;
  }
}

// ── Acties ───────────────────────────────────────────────────────────────

async function listInstitutions(country: string): Promise<unknown[]> {
  const data = await ebApp(`/aspsps?country=${encodeURIComponent(country)}`);
  const aspsps = Array.isArray(data?.aspsps) ? data.aspsps : [];
  return aspsps.map((a: any) => ({
    id: a.name, name: a.name, bic: a.bic ?? null, logo: a.logo ?? null,
    // maximum_consent_validity is in SECONDEN.
    max_consent_days: Number(a.maximum_consent_validity) > 0 ? Math.floor(Number(a.maximum_consent_validity) / 86400) : null,
    psu_types: Array.isArray(a.psu_types) ? a.psu_types : null,
  }));
}

/** Het maximum dat deze bank toestaat (seconden), of null als het niet te vinden is. */
async function maxConsentSeconds(aspspName: string, psu: PsuHeaders): Promise<number | null> {
  try {
    const data = await ebApp(`/aspsps?country=${encodeURIComponent(EB_COUNTRY)}`, undefined, psu);
    const aspsp = (Array.isArray(data?.aspsps) ? data.aspsps : []).find((a: any) => a?.name === aspspName);
    const max = Number(aspsp?.maximum_consent_validity);
    return Number.isFinite(max) && max > 0 ? max : null;
  } catch (e) {
    console.warn('bank-sync: maximum toestemmingsduur niet opgehaald', aspspName, describeError(e));
    return null;
  }
}

async function createRequisition(req: Request, userId: string, organizationId: string, body: Record<string, unknown>, psu: PsuHeaders) {
  const aspspName = String(body.institutionId || '').trim(); // Enable Banking gebruikt de naam als id
  const institutionName = body.institutionName ? String(body.institutionName) : aspspName;
  const redirectUrl = String(body.redirectUrl || '').trim();
  if (!aspspName) throw new HttpError('Kies een bank.', 400);
  assertRedirectAllowed(req, redirectUrl);

  const state = crypto.randomUUID();
  // Zo lang als we willen, maar nooit langer dan deze bank toestaat: vragen we
  // meer, dan weigert de bank de hele koppeling.
  const validUntil = consentValidUntil(Date.now(), EB_CONSENT_DAYS, await maxConsentSeconds(aspspName, psu)).toISOString();
  const auth = await ebApp('/auth', {
    method: 'POST',
    body: JSON.stringify({
      access: { valid_until: validUntil },
      aspsp: { name: aspspName, country: EB_COUNTRY },
      redirect_url: redirectUrl,
      state,
      psu_type: EB_PSU_TYPE,
    }),
  }, psu);
  if (!auth?.url) throw new HttpError('Enable Banking gaf geen koppel-link terug.', 502);

  const { error } = await supabaseAdmin.from('bank_requisitions').insert({
    organization_id: organizationId, created_by: userId, provider: 'enablebanking',
    institution_id: aspspName, institution_name: institutionName, institution_country: EB_COUNTRY,
    reference: state, link: auth.url, status: 'created', expires_at: validUntil,
  });
  if (error) throw new HttpError(`Kon de koppeling niet vastleggen: ${error.message}`, 500);

  return { link: auth.url as string, reference: state };
}

async function finalizeRequisition(userId: string, code: string, state: string, psu: PsuHeaders, deadline: number) {
  if (!code || !state) throw new HttpError('Ontbrekende autorisatiecode of state.', 400);
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

  // Dezelfde terugkeer-URL nog eens geopend: de code is al ingewisseld en een
  // tweede poging faalt bij de bank. Niets opnieuw doen, en vooral de
  // werkende koppeling niet op 'error' zetten.
  if (reqRow.status === 'linked') {
    return { status: 'linked', linked: 0, imported: 0, alreadyLinked: true };
  }

  let session: any;
  try {
    session = await ebApp('/sessions', { method: 'POST', body: JSON.stringify({ code }) }, psu);
  } catch (e) {
    await supabaseAdmin.from('bank_requisitions').update({ status: 'error', error: describeError(e) })
      .eq('id', reqRow.id).in('status', ['created', 'error']);
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
      const details = await eb(`/accounts/${uid}/details`, undefined, psu);
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
      // Een rij met een ANDER extern id is het herkoppel-geval: na het verlopen
      // van de toestemming geeft Enable Banking vaak een nieuw account-uid uit.
      // Zouden we die overslaan, dan komt er een tweede rij met dezelfde IBAN die
      // óók op dezelfde grootboekrekening boekt (dubbeltelling). Een rij die nog
      // nooit gekoppeld was, is de klassieke import→koppel-samenvoeging.
      // Na review: bij herkoppelen gaat de rij die al gekoppeld was voor — die
      // heeft de geschiedenis van de koppeling. Anders bleef die oude rij aan de
      // verlopen toestemming hangen (met rode melding en 401 bij elke sync).
      const match = sameIban.find(c => c.external_account_id) ?? sameIban[0];
      if (match) existing = { id: match.id };
    }
    let bankAccountId: string | null = null;
    if (existing) {
      const { error: updErr } = await supabaseAdmin.from('bank_accounts').update({
        name, iban, provider: 'enablebanking', source: 'enablebanking',
        external_account_id: uid, bank_requisition_id: reqRow.id, is_active: true,
      }).eq('id', existing.id);
      if (!updErr) { linked += 1; bankAccountId = existing.id; }
    } else {
      const { data: inserted, error: insErr } = await supabaseAdmin.from('bank_accounts').insert({
        organization_id: organizationId, created_by: userId, name, iban, currency: 'EUR',
        ledger_account_id: ledgerAccountId, source: 'enablebanking', provider: 'enablebanking',
        external_account_id: uid, bank_requisition_id: reqRow.id, is_active: true,
      }).select('id').single();
      if (!insErr && inserted) { linked += 1; bankAccountId = inserted.id as string; }
    }
    // Een eigen grootboekrekening als hij er één deelt met een ándere rekening
    // (bv. een spaarrekening naast de betaalrekening). Zelfde IBAN, of al
    // geboekt: blijft waar hij is — de RPC bewaakt dat.
    if (bankAccountId) {
      const { error: ownErr } = await supabaseAdmin.rpc('assign_own_bank_ledger_account', {
        p_organization_id: organizationId, p_bank_account_id: bankAccountId,
      });
      if (ownErr) console.warn('bank-sync: eigen grootboekrekening niet toegekend', bankAccountId, ownErr.message);
    }
  }

  await supabaseAdmin.from('bank_requisitions').update({
    status: 'linked', requisition_id: sessionId, accounts: accountUids, linked_at: new Date().toISOString(), error: null,
  }).eq('id', reqRow.id);

  const synced = await syncAccounts(organizationId, null, { psu, deadline });
  const imported = synced.results.reduce((s, r) => s + (r.inserted || 0), 0);
  return { status: 'linked', linked, imported };
}

type SyncOptions = { psu?: PsuHeaders; deadline?: number; perAccountMs?: number };
type SyncResult = {
  bankAccountId: string; inserted: number; skipped: number;
  pending?: number; unknownStatus?: number; balance?: { cents: number; date: string } | null;
  /** Niet alles opgehaald (tijd op): de volgende sync gaat verder waar deze stopte. */
  truncated?: boolean;
  /** Zo ver terug geeft de bank niets meer zonder nieuwe bankauthenticatie: deze dagen ontbreken. */
  gap?: { from: string; through: string };
  error?: string; errorKind?: EbErrorKind | 'config' | 'internal';
};

async function importTransactions(organizationId: string, bankAccountId: string, txns: MappedBankTransaction[]) {
  if (txns.length === 0) return { inserted: 0, skipped: 0 };
  const dates = txns.map((t) => t.booking_date).sort();
  const statement = {
    format: 'enablebanking', file_name: null, file_hash: null,
    period_start: dates[0], period_end: dates[dates.length - 1],
    opening_balance_cents: null, closing_balance_cents: null,
  };
  const { data, error } = await supabaseAdmin.rpc('import_bank_transactions', {
    p_organization_id: organizationId, p_bank_account_id: bankAccountId, p_statement: statement, p_transactions: txns,
  });
  if (error) throw new Error(error.message);
  return { inserted: Number((data as any)?.inserted ?? 0), skipped: Number((data as any)?.skipped ?? 0) };
}

/**
 * Per rekening: ophalen vanaf de dag na sync_through (hoogstens 89 dagen terug),
 * in stukken van oud naar nieuw. Na elk volledig stuk staat in sync_through hoe
 * ver alles vaststaat; is de tijd op, dan gaat de volgende sync daar verder
 * (vroeger begon hij steeds opnieuw en kwam hij nooit verder). Past al het eerste
 * stuk niet, dan is het de volgende keer half zo groot (sync_slice_days).
 * Elke poging, en elke fout met zijn wachttijd, staat op de rekening.
 */
async function syncAccounts(organizationId: string, bankAccountId: string | null, opts: SyncOptions = {}) {
  let query = supabaseAdmin.from('bank_accounts').select('*')
    .eq('organization_id', organizationId).eq('source', 'enablebanking').eq('is_active', true);
  if (bankAccountId) query = query.eq('id', bankAccountId);
  const { data: accounts, error } = await query;
  if (error) throw new HttpError(`Bankrekeningen ophalen mislukt: ${error.message}`, 500);
  if (!accounts || accounts.length === 0) return { results: [] as SyncResult[], needsReconsent: false };

  // De toestemmingen erbij: hun sessie-id maakt het onderscheid tussen een
  // verlopen toestemming en een probleem met één rekening.
  const reqIds = [...new Set(accounts.map((a: any) => a.bank_requisition_id).filter(Boolean))] as string[];
  const { data: reqRows } = reqIds.length
    ? await supabaseAdmin.from('bank_requisitions').select('id, requisition_id, status, expires_at').in('id', reqIds)
    : { data: [] };
  const reqById = new Map(((reqRows ?? []) as any[]).map((r) => [r.id as string, r]));

  const psu = opts.psu ?? {};
  const results: SyncResult[] = [];
  let needsReconsent = false;

  for (const acc of accounts) {
    if (!acc.external_account_id) { results.push({ bankAccountId: acc.id, inserted: 0, skipped: 0, error: 'geen extern account-id', errorKind: 'internal' }); continue; }
    // Is de tijd al op voordat deze rekening begint, dan de volgende keer.
    if (opts.deadline !== undefined && Date.now() > opts.deadline) { results.push({ bankAccountId: acc.id, inserted: 0, skipped: 0, truncated: true }); continue; }

    const startedAt = Date.now();
    const accountDeadline = Math.min(opts.deadline ?? Infinity, opts.perAccountMs ? startedAt + opts.perAccountMs : Infinity);
    const outOfTime = () => Date.now() > accountDeadline;
    await supabaseAdmin.from('bank_accounts').update({ sync_attempted_at: new Date(startedAt).toISOString() }).eq('id', acc.id);
    const req = acc.bank_requisition_id ? reqById.get(acc.bank_requisition_id) : undefined;
    const today = amsterdamDate(new Date(startedAt).toISOString())!;
    const { from, capped } = syncWindow(acc.sync_through ?? null, acc.last_synced_at ?? null, today);
    const sliceDays = sliceDaysOf(acc.sync_slice_days);
    let nextSliceDays = sliceDays;
    let through: string | null = acc.sync_through ?? null;
    let inserted = 0, skipped = 0, pending = 0, unknownStatus = 0, truncated = false, completed = 0;

    try {
      const slices = dateSlices(from, today, sliceDays);
      while (slices.length > 0) {
        const [sliceFrom, sliceTo] = slices.shift()!;
        const fetched = await fetchAllTransactionPages(
          (key) => eb(`/accounts/${acc.external_account_id}/transactions?date_from=${sliceFrom}&date_to=${sliceTo}`
            + (key ? `&continuation_key=${encodeURIComponent(key)}` : ''), undefined, psu),
          undefined,
          outOfTime,
        );
        // Alleen geboekte transacties; pending komt later als geboekt terug.
        const prepared = prepareEbTransactions(fetched.transactions);
        pending += prepared.pending; unknownStatus += prepared.unknownStatus;
        const imported = await importTransactions(organizationId, acc.id, prepared.transactions);
        inserted += imported.inserted; skipped += imported.skipped;

        const days = Math.round((Date.parse(sliceTo) - Date.parse(sliceFrom)) / 86_400_000) + 1;
        if (fetched.reason === 'pages' && days > 1) {
          // Te veel voor één stuk: in tweeën en opnieuw. Wat al binnen is, slaat de
          // import over.
          const mid = addDays(sliceFrom, Math.floor((days - 1) / 2));
          slices.unshift([sliceFrom, mid], [addDays(mid, 1), sliceTo]);
          continue;
        }
        if (fetched.reason === 'time' && (completed > 0 || days > 1 || accountDeadline - startedAt < MIN_SLICE_BUDGET_MS)) {
          // Nog niet alles: de volgende keer verder vanaf sync_through. Was dit het
          // eerste stuk en had de rekening zijn tijd, dan is het stuk te groot.
          if (completed === 0 && days > 1 && accountDeadline - startedAt >= MIN_SLICE_BUDGET_MS) {
            nextSliceDays = Math.max(1, Math.floor(days / 2));
          }
          truncated = true;
          break;
        }
        // Een enkele dag die niet binnen het plafond (pagina's of tijd) past: verder
        // dan dit gaat het niet, en zonder door te schuiven kwam de rekening nooit
        // meer verder. Ligt die dag in de laatste week, dan komt hij nog terug.
        if (fetched.reason) console.warn('bank-sync: één dag past niet', fetched.reason, acc.id, sliceFrom);
        completed += 1;
        const settled = settledThrough(sliceTo, today);
        if (!through || settled > through) {
          await supabaseAdmin.from('bank_accounts').update({ sync_through: settled }).eq('id', acc.id);
          through = settled;
        }
        if (slices.length > 0 && outOfTime()) { truncated = true; break; }
      }
      // Een hele sync gelukt: weer grotere stukken, tot 30 dagen.
      if (!truncated && sliceDays < SLICE_DAYS) nextSliceDays = Math.min(SLICE_DAYS, sliceDays * 2);

      // Het saldo alleen als alles binnen is: anders klopt het niet met de boekingen.
      const balance = truncated ? null : await recordBookedBalance(organizationId, acc, psu);
      await supabaseAdmin.from('bank_accounts').update({
        // Pas als alles binnen is, telt hij als bijgewerkt.
        ...(truncated ? {} : { last_synced_at: new Date().toISOString() }),
        sync_slice_days: nextSliceDays === SLICE_DAYS ? null : nextSliceDays,
        sync_failures: 0, sync_error: null, sync_error_kind: null,
        // Afgekapt: over een uur verder; de geplande ronde neemt eerst de anderen.
        sync_retry_after: truncated ? new Date(Date.now() + HOUR_MS).toISOString() : null,
      }).eq('id', acc.id);
      // Het werkt weer, dan staat de toestemming ook (weer).
      if (req && req.status === 'expired' && (!req.expires_at || Date.parse(req.expires_at) > Date.now())) {
        await supabaseAdmin.from('bank_requisitions').update({ status: 'linked' }).eq('id', req.id).eq('status', 'expired');
        req.status = 'linked';
      }
      results.push({
        bankAccountId: acc.id, inserted, skipped, pending, unknownStatus, balance,
        ...(truncated ? { truncated: true } : {}), ...(capped ? { gap: { from: capped, through: addDays(from, -1) } } : {}),
      });
    } catch (e) {
      const err = e instanceof EbError ? await resolveAuthError(e, req?.requisition_id ?? null) : null;
      const kind: SyncResult['errorKind'] = err ? err.kind : 'internal';
      const failures = (Number(acc.sync_failures) || 0) + 1;
      const retry = retryAfter(kind!, failures, Date.now());
      const message = err ? err.message : 'Synchroniseren mislukt door een interne fout.';
      await supabaseAdmin.from('bank_accounts').update({
        sync_failures: failures, sync_retry_after: retry ? retry.toISOString() : null,
        sync_error: message, sync_error_kind: kind,
      }).eq('id', acc.id);
      if (kind === 'reconsent') {
        needsReconsent = true;
        if (req && req.status !== 'expired') {
          await supabaseAdmin.from('bank_requisitions').update({ status: 'expired' }).eq('id', req.id);
          req.status = 'expired';
        }
      }
      const technical = e instanceof EbError ? e.detail : describeError(e);
      if (kind === 'config') console.error('bank-sync: Enable Banking weigert onze sleutel', technical);
      else console.warn('bank-sync: rekening niet gesynchroniseerd', acc.id, kind, technical);
      // Wat vóór de fout al binnen was, telt gewoon mee.
      results.push({ bankAccountId: acc.id, inserted, skipped, error: message, errorKind: kind });
    }
  }
  return { results, needsReconsent };
}

// ── Geplande sync (cron) ─────────────────────────────────────────────────

async function handleSyncCron(req: Request): Promise<Response> {
  if (!BANK_SYNC_CRON_SECRET) return json(req, { ok: false, error: 'BANK_SYNC_CRON_SECRET ontbreekt in de Edge Function secrets.' }, 500);
  // Alleen via de header: een secret in de URL belandt in toegangslogs.
  const provided = req.headers.get('x-cron-secret') || '';
  if (!timingSafeEqual(provided, BANK_SYNC_CRON_SECRET)) return json(req, { ok: false, error: 'Invalid cron secret' }, 401);
  try {
    const summary = await runScheduledSync();
    console.log('bank-sync cron', JSON.stringify(summary));
    return json(req, { ok: true, ...summary });
  } catch (error) {
    console.error('bank-sync cron error', describeError(error));
    return json(req, { ok: false, error: describeError(error) }, 500);
  }
}

/**
 * Eén ronde: verlopen toestemmingen markeren (dan ziet het scherm het, en zet de
 * beslislijst een kaart klaar), daarna de rekeningen die aan de beurt zijn —
 * langst niet opgehaald eerst — tot het tijdsbudget op is. Wat niet past, komt
 * het volgende uur. Eén rekening die faalt, houdt de rest niet tegen.
 */
async function runScheduledSync() {
  const started = Date.now();
  const deadline = started + CRON_TIME_BUDGET_MS;

  const { data: expired, error: expErr } = await supabaseAdmin.from('bank_requisitions')
    .update({ status: 'expired' })
    .eq('status', 'linked').lt('expires_at', new Date().toISOString())
    .select('id');
  if (expErr) console.warn('bank-sync cron: verlopen toestemmingen niet gemarkeerd', expErr.message);

  const { data: due, error } = await supabaseAdmin.rpc('bank_accounts_due_for_sync', {
    p_min_interval: SCHEDULED_SYNC_INTERVAL, p_limit: 200,
  });
  if (error) throw new Error(`bank_accounts_due_for_sync: ${error.message}`);
  const rows = (due ?? []) as Array<{ bank_account_id: string; organization_id: string }>;

  const summary = {
    expiredConsents: expired?.length ?? 0, due: rows.length, synced: 0, failed: 0, inserted: 0,
    needsReconsent: 0, rateLimited: 0, truncated: 0, postponed: 0, ms: 0,
  };
  for (const [index, row] of rows.entries()) {
    if (Date.now() > deadline) { summary.postponed = rows.length - index; break; }
    // Zonder PSU-headers: de gebruiker is er niet bij (dit telt mee voor de vier per dag).
    const { results } = await syncAccounts(row.organization_id, row.bank_account_id, { deadline, perAccountMs: CRON_PER_ACCOUNT_MS });
    for (const r of results) {
      if (r.error) summary.failed += 1; else summary.synced += 1;
      summary.inserted += r.inserted || 0;
      if (r.errorKind === 'reconsent') summary.needsReconsent += 1;
      if (r.errorKind === 'rate_limited') summary.rateLimited += 1;
      if (r.truncated) summary.truncated += 1;
    }
  }
  summary.ms = Date.now() - started;
  return summary;
}

/**
 * Het geboekte saldo van de bank vastleggen als afschriftsaldo, zodat de
 * saldo-aansluiting ook voor een gekoppelde rekening werkt (die had nooit een
 * eindsaldo; alleen CAMT/MT940-imports leverden er een). Optioneel: levert de
 * bank geen geboekt saldo, of faalt de aanroep, dan blijft de sync geslaagd.
 */
async function recordBookedBalance(organizationId: string, acc: any, psu: PsuHeaders): Promise<{ cents: number; date: string } | null> {
  try {
    const data = await eb(`/accounts/${acc.external_account_id}/balances`, undefined, psu);
    // Boekdatums van NL-banken zijn lokale datums; "vandaag" dus ook in NL-tijd.
    const today = amsterdamDate(new Date().toISOString())!;
    const balance = pickBookedBalance(data?.balances, acc.currency || 'EUR', today);
    if (!balance) return null;
    const { error } = await supabaseAdmin.rpc('record_bank_balance', {
      p_organization_id: organizationId, p_bank_account_id: acc.id,
      p_balance_date: balance.date, p_balance_cents: balance.amount_cents,
      p_source: 'enablebanking', p_label: `Saldo volgens de bank (${balance.type})`,
    });
    if (error) throw new Error(error.message);
    return { cents: balance.amount_cents, date: balance.date };
  } catch (e) {
    console.warn('bank-sync: saldo niet vastgelegd', acc.id, describeError(e));
    return null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * De standaard-bankrekening: 1100, anders de laagste rekening met subtype bank.
 * Niet zomaar "een" bankrekening: sinds er per gekoppelde rekening een eigen
 * 11x0-rekening kan zijn, zou een ongesorteerde keuze een nieuwe rekening op die
 * van een andere bank kunnen zetten.
 */
async function defaultBankLedgerAccount(organizationId: string): Promise<string> {
  const { data } = await supabaseAdmin.from('ledger_accounts').select('id, code, subtype')
    .eq('organization_id', organizationId).or('subtype.eq.bank,code.eq.1100').order('code');
  const rows = (data ?? []) as Array<{ id: string; code: string; subtype: string | null }>;
  const id = rows.find((r) => r.code === '1100')?.id ?? rows.find((r) => r.subtype === 'bank')?.id;
  if (!id) throw new HttpError('Geen bank-grootboekrekening (1100) gevonden. Richt eerst je rekeningschema in.', 422);
  return id;
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
function timingSafeEqual(a: string, b: string): boolean { const enc = new TextEncoder(); const left = enc.encode(a); const right = enc.encode(b); if (left.length !== right.length) return false; let out = 0; for (let i = 0; i < left.length; i++) out |= left[i] ^ right[i]; return out === 0; }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function describeError(error: unknown): string { if (error instanceof Error) return error.message; try { return JSON.stringify(error); } catch { return String(error); } }
function parsePositiveInt(value: string | null | undefined, fallback: number): number { const n = Number.parseInt(String(value ?? ''), 10); return Number.isFinite(n) && n > 0 ? n : fallback; }
function requiredEnv(name: string): string { const value = Deno.env.get(name); if (!value) throw new Error(`Missing required env var: ${name}`); return value; }
