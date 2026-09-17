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

function restRows(table, url) {
  const select = url.searchParams.get('select') ?? '*';
  if (table === 'organization_members') {
    if (select.includes('organizations(')) return seed.members.filter(m => m.user_id === seed.ids.USER).map(m => ({ ...m, organization: seed.org }));
    return seed.members;
  }
  if (table === 'organizations') return [seed.org];
  const rows = seed.tables[table];
  if (!rows) return [];
  let out = rows;
  for (const [k, v] of url.searchParams.entries()) {
    if (['select', 'order', 'limit', 'offset', 'or', 'and'].includes(k)) continue;
    const m = /^eq\.(.*)$/.exec(v);
    if (m && out.length && k in out[0]) out = out.filter(r => String(r[k]) === m[1]);
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

function rpc(fn) {
  switch (fn) {
    case 'ensure_user_default_organization': return null;
    case 'organization_license_usage': return [{ organization_id: seed.ids.ORG, licensed_seats: 3, active_members: 2, pending_invitations: 0, used_seats: 2, available_seats: 1, license_status: 'active', billing_exempt: false }];
    case 'organization_billing_overview': return [];
    case 'chat_unread_counts': return [{ conversation_id: seed.chatConversations[0].id, unread_count: 2 }];
    case 'organization_creative_status': return [{ active: true, enabled: true, included_in_plan: true, in_grace: false, grace_until: null, addon_price_cents: 900, addon_yearly_price_cents: 9000, billing_interval: 'month' }];
    case 'organization_business_status': return [{ active: true, enabled: true, included_in_plan: true, in_grace: false, grace_until: null, legal_form: 'bv', fiscal_regime: 'vpb', is_corporate: true }];
    default: return [];
  }
}

function edgeFunction(name, body) {
  if (name === 'calendar-integrations') {
    const action = body?.action;
    if (action === 'listIntegrations') return { ok: true, connections: [], sources: [seed.calendarSource] };
    if (action === 'listEvents') return { ok: true, events: seed.events };
    return { ok: true, connections: [], sources: [seed.calendarSource], calendars: [seed.calendarSource], events: [], attendees: [], links: [], slots: [], ics: [] };
  }
  if (name === 'meeting-booking') return { ok: true, links: [], slots: [], bookings: [], link: null };
  // Publieke klantpagina's en het portaal.
  if (name === 'quote-public') return pub.quotePublic;
  if (name === 'invoice-public') return pub.invoicePublic;
  if (name === 'contract-public') return pub.contractPublic;
  if (name === 'meeting-booking-public') return pub.bookingPublic;
  if (name === 'file-share-public') return pub.sharePublic;
  if (name === 'gallery-public') return pub.galleryPublic;
  if (name === 'client-portal') return pub.portalData;
  if (name === 'portal-login') return { ok: true, known: true };
  if (name === 'gerrie-agent') return { ok: true, budget: { remaining_cents: 5000 }, remaining: 5000, tools: [], proposals: [], usage: [] };
  return { ok: true };
}

/** Koppel de mock aan een Playwright-context. */
export async function installMock(context) {
  await context.route(`${SUPABASE_URL}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (p.startsWith('/auth/v1/user')) return json(route, seed.user);
    if (p.startsWith('/auth/v1/token')) return json(route, session);
    if (p.startsWith('/auth/v1/logout')) return json(route, undefined, 204);
    if (p.startsWith('/rest/v1/rpc/')) return json(route, rpc(p.slice('/rest/v1/rpc/'.length)));
    if (p.startsWith('/rest/v1/')) {
      const table = p.slice('/rest/v1/'.length);
      if (req.method() !== 'GET' && req.method() !== 'HEAD') return json(route, []);
      const rows = restRows(table, url);
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
      return json(route, edgeFunction(p.slice('/functions/v1/'.length).split('/')[0], body));
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
