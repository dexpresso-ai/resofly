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

function rpc(fn) {
  switch (fn) {
    case 'ensure_user_default_organization': return null;
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
      if (req.method() !== 'GET' && req.method() !== 'HEAD') {
        if (!CHAT_WRITABLE.has(table)) return json(route, []);
        let body = null; try { body = req.postDataJSON(); } catch { /* geen json-body */ }
        const written = chatWrite(table, req.method(), url, body);
        const wantsObject = (req.headers()['accept'] ?? '').includes('pgrst.object');
        return json(route, wantsObject ? (written[0] ?? null) : written, req.method() === 'POST' ? 201 : 200);
      }
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
