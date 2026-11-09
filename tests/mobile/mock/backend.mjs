// Nagebootste Supabase voor de mobiele lay-outtest. Alles wat de app naar
// example.supabase.co stuurt wordt hier beantwoord vanuit seed.mjs, zodat de
// test zonder database, zonder account en zonder netwerk draait.
//
// Bewust géén volledige PostgREST: alleen wat de pagina's bij het openen
// nodig hebben (select met eq-filters, rpc's, een handvol edge functions).
// Schrijfacties krijgen een leeg antwoord — de test klikt niets weg.
import * as seed from './seed.mjs';
import * as pub from './publicdata.mjs';

export const SUPABASE_URL = 'https://example.supabase.co';
export const MEDIA_URL = 'https://media.example.test';
// 8×6 px, effen olijfgroen; groot genoeg voor een <img> die zich schaalt.
const TILE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAGklEQVQIW2NkYPjPwMDwn4EBzGBgYGAAAgwADQ4CAUUb5jsAAAAASUVORK5CYII=';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
const accessToken = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: seed.ids.USER, email: seed.user.email, role: 'authenticated', aud: 'authenticated', exp, iat: exp - 3600, session_id: 'sess-1' })}.mocksig`;
export const session = { access_token: accessToken, refresh_token: 'mock-refresh', token_type: 'bearer', expires_in: 3600 * 24 * 30, expires_at: exp, user: seed.user };

// `content-range` is geen standaard CORS-header: zonder expose-headers ziet de
// browser hem niet, en dan geeft elke telling (`count: 'exact', head: true`)
// stilletjes nul terug — de opvangbak leek in de test altijd leeg.
const json = (route, body, status = 200, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range', ...headers }, body: body === undefined ? '' : JSON.stringify(body) });

// ── Een nieuwe organisatie die nog wordt ingericht (OrganizationSetup) ─────
//
// installMock(context, { onboarding: true }) speelt een organisatie na die
// net is aangemaakt: onboarding_completed_at leeg, nog geen abonnement, de
// zakelijke module uit en Mollie niet gekoppeld. De bedrijfsgegevens, het
// abonnement, de modules, Mollie en het afronden werken in het geheugen, met
// dezelfde weigeringen als de echte backend (een BV zonder module, een admin
// die Mollie koppelt). Zo kan tests/inrichten de stappen echt doorlopen.
// `role: 'member'` maakt van de gebruiker een gewoon teamlid; `emptySettings`
// begint zonder bedrijfsgegevens, zoals een organisatie van create_organization.
const BUSINESS_FORMS = ['bv', 'nv', 'cooperatie'];
const PLANS = [
  { plan_key: 'starter', name: 'Starter', description: 'Voor solo-gebruikers en kleine starts.', included_seats: 1, monthly_price_cents: 1500, yearly_price_cents: 18000, extra_seat_price_cents: 900, extra_seat_yearly_price_cents: 10800, currency: 'EUR', is_custom: false, is_active: true, sort_order: 10, limits: { storage_gb: 50, included_seats: 1 }, creative_addon_price_cents: 900, creative_addon_yearly_price_cents: 9000, business_addon_price_cents: 1900, business_addon_yearly_price_cents: 19000 },
  { plan_key: 'team', name: 'Team', description: 'Voor kleine teams met standaard samenwerking.', included_seats: 3, monthly_price_cents: 3900, yearly_price_cents: 46800, extra_seat_price_cents: 800, extra_seat_yearly_price_cents: 9600, currency: 'EUR', is_custom: false, is_active: true, sort_order: 20, limits: { storage_gb: 250, included_seats: 3 }, creative_addon_price_cents: 900, creative_addon_yearly_price_cents: 9000, business_addon_price_cents: 1900, business_addon_yearly_price_cents: 19000 },
  { plan_key: 'pro', name: 'Pro', description: 'Voor grotere teams met ruimere capaciteit.', included_seats: 10, monthly_price_cents: 9900, yearly_price_cents: 118800, extra_seat_price_cents: 700, extra_seat_yearly_price_cents: 8400, currency: 'EUR', is_custom: false, is_active: true, sort_order: 30, limits: { storage_gb: 1000, included_seats: 10 }, creative_addon_price_cents: 900, creative_addon_yearly_price_cents: 9000, business_addon_price_cents: 1900, business_addon_yearly_price_cents: 19000 },
  { plan_key: 'custom', name: 'Custom', description: 'Handmatig afgestemd contract.', included_seats: null, monthly_price_cents: 0, yearly_price_cents: 0, extra_seat_price_cents: 0, extra_seat_yearly_price_cents: 0, currency: 'EUR', is_custom: true, is_active: true, sort_order: 90, limits: { business_included: true, creative_included: true } },
];

// ── Het webadres (migratie 20261108230000) ─────────────────────────────────
//
// client_subdomain_check zegt of een naam vrij is; de vorm controleert de app
// zelf al (src/lib/clientDomains.ts), dus hier komen alleen goedgevormde
// namen. "bestaat-al" en "jansen" zijn van een ander, "www" en alles met
// "resofly" gereserveerd. Het overzicht is dat van client-domains.
const CLIENT_BASE = 'resofly.com';
const TAKEN_SUBDOMAINS = new Set(['bestaat-al', 'jansen', 'fotostudio']);
const RESERVED_SUBDOMAINS = new Set(['www', 'app', 'api', 'admin', 'mail', 'portal', 'portaal', 'support', 'klant', 'domeinen']);

function subdomainCheck(own, body) {
  const name = String(body?.p_name ?? '');
  if (own && name === own) return { name, status: 'own', reason: null, message: null };
  if (RESERVED_SUBDOMAINS.has(name) || /resofly|rabobank|paypal/.test(name)) return { name, status: 'reserved', reason: 'gereserveerd', message: 'Deze naam is niet beschikbaar. Kies een andere.' };
  if (TAKEN_SUBDOMAINS.has(name)) return { name, status: 'taken', reason: 'bestaat', message: 'Dit adres bestaat al. Kies een andere naam.' };
  return { name, status: 'available', reason: null, message: null };
}

function clientDomainsOverview({ subdomain, allowed, domain = null, previous = [], moved = [] }) {
  return {
    ok: true,
    config: { base: CLIENT_BASE, live: false, cnameTarget: `domeinen.${CLIENT_BASE}`, customDomainsAvailable: true },
    customDomainAllowed: allowed,
    subdomain: subdomain ? { name: subdomain, host: `${subdomain}.${CLIENT_BASE}` } : null,
    blocked: false,
    previous,
    domain,
    moved,
    // Leeg: de app valt terug op zijn eigen adres, zoals voorheen in deze test.
    clientUrl: '',
    onClientHost: false,
    portalUrl: '',
    portalOnClientHost: false,
  };
}

// Instellingen → Domein in zijn langste stand: een adres, een eerder adres,
// een eigen domein dat nog op het record wacht (met de melding waar het nu
// naar wijst, het CNAME- en het TXT-record) en een verhuisd domein.
const WORKSPACE_DOMAIN = {
  id: 'd0d0d0d0-0000-4000-8000-000000000001',
  hostname: 'albums.studio-lopik-fotografie.nl',
  status: 'pending_dns',
  problem: 'albums.studio-lopik-fotografie.nl wijst nu naar studio-lopik-fotografie.nl. Verander het CNAME-record in domeinen.resofly.com.',
  cnameFound: ['studio-lopik-fotografie.nl'],
  records: [
    { type: 'CNAME', name: 'albums.studio-lopik-fotografie.nl', value: 'domeinen.resofly.com' },
    { type: 'TXT', name: '_cf-custom-hostname.albums.studio-lopik-fotografie.nl', value: '0f6a1e2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b' },
  ],
  verifiedAt: null,
  lastCheckedAt: '2026-11-08T09:00:00Z',
  createdAt: '2026-11-08T08:55:00Z',
  portalEnabled: false,
};
const WORKSPACE_OVERVIEW = clientDomainsOverview({
  subdomain: 'studio-lopik',
  allowed: true,
  domain: WORKSPACE_DOMAIN,
  previous: [{ name: 'lopik', host: `lopik.${CLIENT_BASE}`, redirectUntil: '2027-11-08T09:00:00Z' }],
  moved: [{ id: 'd0d0d0d0-0000-4000-8000-000000000002', hostname: 'klanten.studio-lopik.nl', redirectUntil: '2027-10-01T00:00:00Z' }],
});

function createSetup(options) {
  if (!options?.onboarding) return null;
  const settings = options.emptySettings ? null : {
    ...seed.companySettings,
    legal_form: 'eenmanszaak',
    invoice_send_method: null,
    brand_logo_data_url: null,
  };
  return {
    role: options.role ?? 'owner',
    completedAt: null,
    orgName: 'Info',
    settings,
    subscription: false,
    business: false,
    creative: false,
    mollie: null,
    /** Het gekozen webadres (client_subdomain_claim); null = nog niet gekozen. */
    subdomain: options.subdomain ?? null,
    /** Elke schrijfactie: { table, method, query, body }. */
    writes: [],
  };
}

function setupOrg(setup) {
  return { ...seed.org, name: setup.orgName, onboarding_completed_at: setup.completedAt, onboarding_completed_by: setup.completedAt ? seed.ids.USER : null };
}

const fail = (status, code, message) => ({ __status: status, body: { code, message, details: null, hint: null } });

function setupSettingsWrite(setup, method, url, body) {
  setup.writes.push({ table: 'company_settings', method, query: url.search, body });
  if (body && BUSINESS_FORMS.includes(body.legal_form) && body.legal_form !== setup.settings?.legal_form && !setup.business) {
    return fail(403, '42501', 'Boekhouden voor een BV, NV of coöperatie hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.');
  }
  const now = new Date().toISOString();
  if (method === 'PATCH') {
    if (url.searchParams.get('organization_id') !== `eq.${seed.ids.ORG}` || !setup.settings) return [];
    setup.settings = { ...setup.settings, ...body, updated_at: now };
    return [setup.settings];
  }
  if (method === 'POST') {
    if (setup.settings) return fail(409, '23505', 'duplicate key value violates unique constraint "company_settings_organization_id_key"');
    setup.settings = { ...seed.companySettings, company_name: '', legal_form: 'eenmanszaak', trade_name: null, address_line1: null, postal_code: null, city: null, country: 'Nederland', email: null, phone: null, website: null, kvk_number: null, vat_number: null, iban: null, invoice_send_method: null, brand_logo_data_url: null, ...body, id: 'cs-onboarding', created_at: now, updated_at: now };
    return [setup.settings];
  }
  return [];
}

function setupRpc(setup, fn, body) {
  const owner = setup.role === 'owner' || setup.role === 'admin';
  switch (fn) {
    case 'organization_billing_overview':
      return owner ? [{
        organization_id: seed.ids.ORG, plan_key: 'starter', plan_name: 'Starter', included_seats: 1, purchased_seats: 0, licensed_seats: 1,
        active_members: 1, pending_invitations: 0, used_seats: 1, available_seats: 0, subscription_status: 'active',
        payment_status: setup.subscription ? 'paid' : 'none', mollie_connect_status: 'not_connected',
        mollie_customer_id: setup.subscription ? 'cst_mock' : null, mollie_mandate_id: setup.subscription ? 'mdt_mock' : null,
        mollie_subscription_id: setup.subscription ? 'sub_mock' : null, last_payment_status: null, next_invoice_date: null,
        trial_ends_at: null, current_period_ends_at: null, monthly_price_cents: 1500, extra_seat_price_cents: 900, currency: 'EUR',
        billing_exempt: false, billing_interval: 'month', yearly_price_cents: 18000, extra_seat_yearly_price_cents: 10800,
        creative_enabled: setup.creative, creative_included_in_plan: false, creative_active: setup.creative, creative_addon_price_cents: 900, creative_addon_yearly_price_cents: 9000,
      }] : [];
    case 'organization_business_status':
      return [{ active: setup.business, enabled: setup.business, included_in_plan: false, in_grace: false, grace_until: null, legal_form: setup.settings?.legal_form ?? 'eenmanszaak', fiscal_regime: BUSINESS_FORMS.includes(setup.settings?.legal_form) ? 'vpb' : 'ib', is_corporate: ['bv', 'nv'].includes(setup.settings?.legal_form), is_child: false, root_organization_id: seed.ids.ORG, entity_count: 1, entity_allowance: 1, addon_price_cents: 1900, addon_yearly_price_cents: 19000, entity_addon_price_cents: 900, entity_addon_yearly_price_cents: 9000, billing_interval: 'month' }];
    case 'organization_creative_status':
      return [{ active: setup.creative, enabled: setup.creative, included_in_plan: false, in_grace: false, grace_until: null, addon_price_cents: 900, addon_yearly_price_cents: 9000, billing_interval: 'month' }];
    case 'client_subdomain_check':
      return subdomainCheck(setup.subdomain, body);
    case 'client_subdomain_claim': {
      setup.writes.push({ table: 'rpc/client_subdomain_claim', method: 'POST', query: '', body });
      if (!owner || body?.p_organization_id !== seed.ids.ORG) return fail(403, '42501', 'Alleen de eigenaar of een beheerder kan het webadres kiezen.');
      const check = subdomainCheck(setup.subdomain, { p_name: body?.p_name });
      if (check.status === 'own') return { name: check.name, previous: null, changed: false };
      if (check.status === 'taken') return fail(409, '23505', `Het adres ${check.name} bestaat al. Kies een andere naam.`);
      if (check.status !== 'available') return fail(400, '22023', check.message ?? 'Deze naam kan niet.');
      const previous = setup.subdomain;
      setup.subdomain = check.name;
      return { name: check.name, previous, changed: true };
    }
    case 'complete_organization_onboarding': {
      setup.writes.push({ table: 'rpc/complete_organization_onboarding', method: 'POST', query: '', body });
      if (!owner) return fail(403, '42501', 'Alleen de eigenaar of een beheerder kan de organisatie inrichten.');
      if (body?.p_organization_id !== seed.ids.ORG) return fail(403, '42501', 'Alleen de eigenaar of een beheerder kan de organisatie inrichten.');
      if (!String(setup.settings?.company_name ?? '').trim()) return fail(400, '23514', 'Vul eerst de naam van je bedrijf in.');
      if (!setup.subdomain) return fail(400, '23514', 'Kies eerst het webadres voor je klanten.');
      if (!setup.completedAt) {
        setup.completedAt = new Date().toISOString();
        setup.orgName = String(body?.p_display_name || setup.settings.trade_name || setup.settings.company_name).slice(0, 120);
      }
      return setupOrg(setup);
    }
    default:
      return undefined;
  }
}

function setupEdgeFunction(setup, name, body) {
  if (name === 'client-domains' && body?.action === 'overview') {
    if (body.organizationId !== seed.ids.ORG) return { __status: 403, body: { ok: false, error: 'Je hebt geen toegang tot deze organisatie.' } };
    return clientDomainsOverview({ subdomain: setup.subdomain, allowed: setup.subscription });
  }
  if (name === 'invoice-workflow' && body?.action === 'getInvoiceMollieStatus') {
    return { ok: true, status: setup.mollie ?? { status: 'not_connected', mode: null, key_suffix: null, connected_at: null, last_validated_at: null, profile: null } };
  }
  if (name === 'invoice-workflow' && body?.action === 'saveInvoiceMollieKey') {
    setup.writes.push({ table: 'fn/saveInvoiceMollieKey', method: 'POST', query: '', body: { organizationId: body.organizationId, keyLength: String(body.apiKey ?? '').length } });
    if (setup.role !== 'owner') return { __status: 403, body: { ok: false, error: 'Alleen de eigenaar van de organisatie kan Mollie koppelen of de key vervangen.' } };
    const key = String(body.apiKey ?? '');
    if (!/^(test|live)_[A-Za-z0-9]{16,128}$/.test(key)) return { __status: 400, body: { ok: false, error: 'Dit lijkt geen Mollie API-key.' } };
    const now = new Date().toISOString();
    setup.mollie = { status: 'connected', mode: key.startsWith('live_') ? 'live' : 'test', key_suffix: key.slice(-4), connected_at: now, last_validated_at: now, profile: { id: 'pfl_MockStudio1', name: 'Studio Lopik', website: 'https://studiolopik.nl', status: 'verified' } };
    return { ok: true, status: setup.mollie, openPaymentsPreviousAccount: false };
  }
  if (name === 'billing') {
    setup.writes.push({ table: `fn/billing/${body?.action}`, method: 'POST', query: '', body });
    switch (body?.action) {
      case 'startSubscriptionCheckout':
        setup.pendingCreative = Boolean(body.creative);
        return { ok: true, mock: true, providerPaymentId: 'mock_payment_onboarding' };
      case 'markMockPaymentPaid':
        setup.subscription = true;
        setup.creative = Boolean(setup.pendingCreative);
        return { ok: true, applied: true, mock: true };
      case 'setBusinessAddon':
        if (!setup.subscription) return { __status: 400, body: { ok: false, error: 'Start eerst een abonnement voordat je de zakelijke module aanzet.' } };
        setup.business = Boolean(body.enabled);
        return { ok: true, applied: true };
      case 'setCreativeAddon':
        if (!setup.subscription) return { __status: 400, body: { ok: false, error: 'Start eerst een abonnement voordat je de creatieve module aanzet.' } };
        setup.creative = Boolean(body.enabled);
        return { ok: true, applied: true };
      default:
        return { ok: true };
    }
  }
  return undefined;
}

function restRows(table, url, setup = null) {
  const select = url.searchParams.get('select') ?? '*';
  if (setup) {
    if (table === 'organization_members') {
      const members = seed.members.map(m => (m.user_id === seed.ids.USER ? { ...m, role: setup.role } : m));
      if (select.includes('organizations(')) return members.filter(m => m.user_id === seed.ids.USER).map(m => ({ ...m, organization: setupOrg(setup) }));
      return members;
    }
    if (table === 'organizations') return [setupOrg(setup)];
    if (table === 'company_settings') return setup.settings ? [setup.settings] : [];
    if (table === 'billing_plans') return PLANS;
  }
  if (table === 'organization_members') {
    if (select.includes('organizations(')) return seed.members.filter(m => m.user_id === seed.ids.USER).map(m => ({ ...m, organization: seed.org }));
    return seed.members;
  }
  if (table === 'organizations') return [seed.org];
  const rows = seed.tables[table];
  if (!rows) return [];
  let out = rows;
  for (const [k, v] of url.searchParams.entries()) {
    if (['select', 'order', 'limit', 'offset', 'or', 'and', 'on_conflict', 'columns'].includes(k)) continue;
    if (!out.length || !(k in out[0])) continue;
    out = out.filter(r => matchFilter(r[k], v));
  }
  // Sortering meenemen (?order=last_message_at.desc.nullslast,created_at.desc):
  // een pagina die op datum aflopend opvraagt, hoort dat ook zo terug te krijgen.
  const order = url.searchParams.get('order');
  if (order && out.length) {
    const specs = order.split(',').map(t => { const [col, ...rest] = t.split('.'); return { col, desc: rest.includes('desc') }; }).filter(sp => sp.col in out[0]);
    if (specs.length) out = [...out].sort((a, b) => {
      for (const { col, desc } of specs) {
        const av = a[col], bv = b[col];
        if (av === bv) continue;
        if (av == null) return 1;
        if (bv == null) return -1;
        return (av < bv ? -1 : 1) * (desc ? -1 : 1);
      }
      return 0;
    });
  }
  return out;
}

// De PostgREST-filters die de pagina's gebruiken: eq/neq, lt/lte/gt/gte (ISO-
// tijden vergelijken als tekst, binnen de seed overal hetzelfde formaat),
// in.(…), is.null/true/false, not.is.null, cs.{…} en ilike met * als joker.
function matchFilter(value, spec) {
  const m = /^(not\.)?(eq|neq|lt|lte|gt|gte|in|is|cs|ilike|like)\.(.*)$/s.exec(spec);
  if (!m) return true;
  const [, neg, op, arg] = m;
  let ok;
  switch (op) {
    case 'eq': ok = String(value) === arg; break;
    case 'neq': ok = String(value) !== arg; break;
    case 'lt': ok = value != null && String(value) < arg; break;
    case 'lte': ok = value != null && String(value) <= arg; break;
    case 'gt': ok = value != null && String(value) > arg; break;
    case 'gte': ok = value != null && String(value) >= arg; break;
    case 'in': ok = arg.replace(/^\(|\)$/g, '').split(',').map(x => x.replace(/^"|"$/g, '')).includes(String(value)); break;
    case 'is': ok = arg === 'null' ? value == null : String(value) === arg; break;
    case 'cs': ok = Array.isArray(value) && arg.replace(/^\{|\}$/g, '').split(',').every(x => value.includes(x)); break;
    default: {
      const pattern = arg.replace(/[.+?^${}()|[\]\\]/g, (c) => `\\${c}`).replace(/[*%]/g, '.*');
      ok = new RegExp(`^${pattern}$`, op === 'ilike' ? 'is' : 's').test(String(value ?? ''));
    }
  }
  return neg ? !ok : ok;
}

// Schrijven op de chattabellen: in het geheugen bijhouden, zodat versturen,
// reageren en opslaan bij het handmatig testen echt iets doen. De lay-outtest
// klikt niets, dus die merkt hier niets van.
const CHAT_WRITABLE = new Set(['chat_messages', 'chat_message_reactions', 'chat_saved_messages', 'chat_member_status']);
function chatWrite(table, method, url, body) {
  const rows = seed.tables[table];
  if (!rows) return [];
  const now = new Date().toISOString();
  if (method === 'POST') {
    const list = Array.isArray(body) ? body : [body];
    const out = [];
    for (const input of list) {
      let row;
      if (table === 'chat_messages') {
        const conv = seed.chatConversations.find(c => c.id === input.conversation_id);
        row = { id: input.id ?? `m${Math.random().toString(16).slice(2, 10)}-0000-4000-8000-000000000000`, organization_id: seed.ids.ORG, sender_id: seed.ids.USER, body: '', mentions: [], attachment_count: 0, edited_at: null, deleted_at: null, kind: 'text', reply_to_id: null, parent_id: null, subject: null, importance: 'normal', meta: {}, pinned_at: null, pinned_by: null, ...input, created_at: now, updated_at: now };
        if (conv) conv.last_message_at = now;
      } else if (table === 'chat_message_reactions') {
        const msg = seed.chatMessages.find(x => x.id === input.message_id);
        row = { ...input, user_id: seed.ids.USER, conversation_id: msg?.conversation_id, organization_id: seed.ids.ORG, created_at: now };
      } else if (table === 'chat_saved_messages') {
        const msg = seed.chatMessages.find(x => x.id === input.message_id);
        row = { ...input, user_id: seed.ids.USER, conversation_id: msg?.conversation_id, organization_id: seed.ids.ORG, created_at: now };
      } else {
        const idx = rows.findIndex(r => r.user_id === seed.ids.USER && r.organization_id === input.organization_id);
        row = { ...(idx >= 0 ? rows[idx] : {}), ...input, user_id: seed.ids.USER, updated_at: now };
        if (idx >= 0) { rows[idx] = row; out.push(row); continue; }
      }
      rows.push(row);
      out.push(row);
    }
    return out;
  }
  const matches = rows.filter(r => [...url.searchParams.entries()].every(([k, v]) => ['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k) || !(k in r) || matchFilter(r[k], v)));
  if (method === 'PATCH') {
    for (const r of matches) Object.assign(r, body, { updated_at: now });
    return matches;
  }
  if (method === 'DELETE') {
    for (const r of matches) rows.splice(rows.indexOf(r), 1);
    return matches;
  }
  return [];
}

function rpc(fn, body = null) {
  switch (fn) {
    case 'ensure_user_default_organization': return null;
    // Instellingen → Domein: de werkruimte heeft al een adres.
    case 'client_subdomain_check': return subdomainCheck(WORKSPACE_OVERVIEW.subdomain.name, body);
    case 'client_subdomain_claim': return { name: String(body?.p_name ?? ''), previous: WORKSPACE_OVERVIEW.subdomain.name, changed: true };
    // Het eigen inlogadres van het portaal (Instellingen → Huisstijl, een klant).
    case 'ensure_portal_login_key': return pub.PORTAL_LOGIN_KEY;
    case 'organization_license_usage': return [{ organization_id: seed.ids.ORG, licensed_seats: 3, active_members: 2, pending_invitations: 0, used_seats: 2, available_seats: 1, license_status: 'active', billing_exempt: false }];
    case 'organization_billing_overview': return [];
    case 'chat_unread_counts': return seed.chatUnread;
    case 'chat_last_messages': {
      const latest = new Map();
      for (const m of seed.chatMessages) { const cur = latest.get(m.conversation_id); if (!cur || cur.created_at < m.created_at) latest.set(m.conversation_id, m); }
      return [...latest.values()].map(m => ({ conversation_id: m.conversation_id, message_id: m.id, sender_id: m.sender_id, body: m.body, kind: m.kind ?? 'text', meta: m.meta ?? {}, attachment_count: m.attachment_count, deleted_at: m.deleted_at, created_at: m.created_at }));
    }
    case 'chat_activity': return seed.chatActivity;
    case 'chat_public_channels': return seed.chatPublicChannels;
    case 'organization_creative_status': return [{ active: true, enabled: true, included_in_plan: true, in_grace: false, grace_until: null, addon_price_cents: 900, addon_yearly_price_cents: 9000, billing_interval: 'month' }];
    case 'organization_business_status': return [{ active: true, enabled: true, included_in_plan: true, in_grace: false, grace_until: null, legal_form: 'bv', fiscal_regime: 'vpb', is_corporate: true }];
    // Debiteuren voor wie Financiën wel en Klanten niet mag lezen (de boekhouder).
    case 'finance_client_directory': return seed.clients.map(({ id, organization_id, name, client_code, client_kind, contact_name, email, phone, vat_number, kvk_number, address_line1, address_line2, postal_code, city, country, e_invoicing_enabled, e_invoice_email, e_invoice_channel }) => ({ id, organization_id, name, client_code, client_kind, contact_name, email, phone, vat_number, kvk_number, address_line1, address_line2, postal_code, city, country, e_invoicing_enabled, e_invoice_email, e_invoice_channel }));
    default: return [];
  }
}

function edgeFunction(name, body) {
  if (name === 'calendar-integrations') {
    const action = body?.action;
    if (action === 'listIntegrations') return { ok: true, connections: seed.calendarConnections, sources: [seed.calendarSource, seed.googleCalendarSource], videoServices: seed.videoServices };
    if (action === 'videoServices') return { ok: true, videoServices: seed.videoServices };
    if (action === 'listEvents') return { ok: true, events: seed.events };
    if (action === 'listAppPasswords') return { ok: true, appPasswords: [] };
    return { ok: true, connections: [], sources: [seed.calendarSource], calendars: [seed.calendarSource], events: [], attendees: [], links: [], slots: [], ics: [] };
  }
  if (name === 'meeting-booking') return { ok: true, links: [], slots: [], bookings: [], link: null };
  if (name === 'client-domains') {
    switch (body?.action) {
      case 'overview': return WORKSPACE_OVERVIEW;
      case 'refreshDomain': return { ok: true, domain: WORKSPACE_DOMAIN };
      case 'addDomain': return { ok: true, domain: { ...WORKSPACE_DOMAIN, hostname: String(body.hostname ?? '') } };
      case 'removeDomain': return { ok: true, removed: true };
      case 'setPortal': return { ok: true, domain: { ...WORKSPACE_DOMAIN, portalEnabled: body.enabled === true } };
      default: return { ok: false, error: `Onbekende actie: ${body?.action}` };
    }
  }
  // Publieke klantpagina's en het portaal.
  if (name === 'quote-public') return pub.quotePublic;
  if (name === 'invoice-public') return pub.invoicePublic;
  if (name === 'contract-public') return pub.contractPublic;
  if (name === 'meeting-booking-public') return pub.bookingPublic;
  if (name === 'file-share-public') return pub.sharePublic;
  if (name === 'gallery-public') return pub.galleryPublic;
  if (name === 'client-portal') {
    switch (body?.action) {
      case 'getMessageThreads': return pub.portalThreads;
      case 'getMessageThread': return pub.portalThread;
      case 'getTicketThread': return pub.portalTicketThread;
      case 'getNotificationSettings': return pub.portalSettings;
      case 'updateNotificationSettings': return { ok: true, settings: body.settings };
      default: return pub.portalData;
    }
  }
  if (name === 'portal-login') return body?.action === 'getBranding' ? (body.key === pub.PORTAL_LOGIN_KEY ? pub.portalLoginBranding : { ok: true, branding: null }) : { ok: true, known: true };
  if (name === 'gerrie-agent') return { ok: true, budget: { remaining_cents: 5000 }, remaining: 5000, tools: [], proposals: [], usage: [] };
  // Instellingen → Betalen: gekoppeld in testmodus, met een lang profiel. Dat
  // is de langste stand van de kaart (profiel, waarschuwing, twee rijen knoppen).
  if (name === 'invoice-workflow' && body?.action === 'getInvoiceMollieStatus') {
    return {
      ok: true,
      status: {
        status: 'connected', mode: 'test', key_suffix: 'a1B2',
        connected_at: '2026-11-01T09:00:00Z', last_validated_at: '2026-11-01T09:00:00Z',
        profile: { id: 'pfl_QkEhN94Ba', name: 'Studio Lopik Fotografie en Vormgeving', website: 'https://www.studio-lopik-fotografie-en-vormgeving.nl', status: 'verified' },
      },
    };
  }
  return { ok: true };
}

/** Een antwoord dat een foutstatus moet krijgen ({ __status, body }), of gewoon JSON. */
function reply(route, result, okStatus = 200, headers = {}) {
  if (result && typeof result === 'object' && '__status' in result) return json(route, result.body, result.__status, headers);
  return json(route, result, okStatus, headers);
}

/**
 * Koppel de mock aan een Playwright-context. Met { onboarding: true } is de
 * organisatie nieuw en moet hij nog worden ingericht (zie createSetup). Geeft
 * de toestand terug, zodat een test kan nagaan wat er is opgeslagen.
 */
export async function installMock(context, options = {}) {
  const setup = createSetup(options);
  await context.route(`${SUPABASE_URL}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (p.startsWith('/auth/v1/user')) return json(route, seed.user);
    if (p.startsWith('/auth/v1/token')) return json(route, session);
    if (p.startsWith('/auth/v1/logout')) return json(route, undefined, 204);
    if (p.startsWith('/rest/v1/rpc/')) {
      const fn = p.slice('/rest/v1/rpc/'.length);
      if (setup) {
        let body = null; try { body = req.postDataJSON(); } catch { /* geen json-body */ }
        const result = setupRpc(setup, fn, body);
        if (result !== undefined) return reply(route, result);
      }
      let rpcBody = null; try { rpcBody = req.postDataJSON(); } catch { /* geen json-body */ }
      return json(route, rpc(fn, rpcBody));
    }
    if (p.startsWith('/rest/v1/')) {
      const table = p.slice('/rest/v1/'.length);
      if (setup && table === 'company_settings' && req.method() !== 'GET' && req.method() !== 'HEAD') {
        let body = null; try { body = req.postDataJSON(); } catch { /* geen json-body */ }
        const result = setupSettingsWrite(setup, req.method(), url, body);
        if (result && '__status' in result) return reply(route, result);
        const wantsObject = (req.headers()['accept'] ?? '').includes('pgrst.object');
        return json(route, wantsObject ? (result[0] ?? null) : result, req.method() === 'POST' ? 201 : 200);
      }
      if (req.method() !== 'GET' && req.method() !== 'HEAD') {
        if (!CHAT_WRITABLE.has(table)) return json(route, []);
        let body = null; try { body = req.postDataJSON(); } catch { /* geen json-body */ }
        const written = chatWrite(table, req.method(), url, body);
        const wantsObject = (req.headers()['accept'] ?? '').includes('pgrst.object');
        return json(route, wantsObject ? (written[0] ?? null) : written, req.method() === 'POST' ? 201 : 200);
      }
      const rows = restRows(table, url, setup);
      const accept = req.headers()['accept'] ?? '';
      const headers = { 'content-range': `0-${Math.max(0, rows.length - 1)}/${rows.length}` };
      if (accept.includes('pgrst.object')) {
        if (rows.length === 0) return json(route, { code: 'PGRST116', details: 'The result contains 0 rows', hint: null, message: 'JSON object requested, multiple (or no) rows returned' }, 406, headers);
        return json(route, rows[0], 200, headers);
      }
      return json(route, rows, 200, headers);
    }
    if (p.startsWith('/functions/v1/')) {
      let body = null; try { body = req.postDataJSON(); } catch { /* geen json-body */ }
      const name = p.slice('/functions/v1/'.length).split('/')[0];
      if (setup) {
        const result = setupEdgeFunction(setup, name, body);
        if (result !== undefined) return reply(route, result);
      }
      return json(route, edgeFunction(name, body));
    }
    if (p.startsWith('/realtime')) return route.abort();
    return json(route, {});
  });
  // De media-worker van de galerij (VITE_R2_WORKER_URL wijst in de test naar
  // dit adres): elke foto is hetzelfde kleine PNG-vlak.
  await context.route(`${MEDIA_URL}/**`, r => r.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: Buffer.from(TILE_PNG_BASE64, 'base64') }));
  // Lettertypen van buiten zijn in een CI-omgeving niet altijd bereikbaar; de
  // test gaat over lay-out, niet over Poppins.
  await context.route('https://fonts.googleapis.com/**', r => r.abort());
  await context.route('https://fonts.gstatic.com/**', r => r.abort());
  return { setup };
}

/** localStorage vóór de eerste pagelaad: sessie, organisatie, thema en het
 *  tabblad dat open moet staan. `spec` is een paginanaam of {page, projectId, clientId}. */
export function storageScript(spec, extra = {}) {
  const orgId = seed.ids.ORG;
  const view = typeof spec === 'string' ? { page: spec } : spec;
  // Een publieke pagina (spec.path) heeft geen medewerkerssessie nodig; het
  // portaal (spec.portal) krijgt zijn eigen sessie onder de portaalsleutel.
  if (view.path) {
    // Een klant heeft geen medewerkerssessie. De pagina's delen binnen één
    // Playwright-context dezelfde localStorage, dus de sessie van de
    // werkruimtepagina's ervoor moet hier eerst weg — anders opent "/" niet
    // het inlogscherm maar de werkruimte.
    const items = { ...(view.portal ? { 'resofly.portal.auth': JSON.stringify(session) } : {}), ...extra };
    return `(() => { localStorage.clear(); const items = ${JSON.stringify(items)}; for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v); })();`;
  }
  const tabs = { tabs: [{ page: view.page, projectId: view.projectId ?? null, clientId: view.clientId ?? null, statsReportId: null, galleryId: null }], activeIndex: 0 };
  const items = {
    'sb-example-auth-token': JSON.stringify(session),
    'brandcore.activeOrganizationId': orgId,
    [`brandcore.tabs.${orgId}`]: JSON.stringify(tabs),
    'brandcore.sidebarPinned': '0',
    'resofly-dashboard-scope': 'mine',
    ...extra,
  };
  return `(() => { const items = ${JSON.stringify(items)}; for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v); })();`;
}

export { seed };
