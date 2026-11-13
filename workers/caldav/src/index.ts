// ResoFly-agendaserver (Cloudflare Worker): de ResoFly-agenda's op een
// telefoon of computer, en deellinks voor mensen buiten ResoFly.
//
// 1. CalDAV (Apple Agenda op iPhone en Mac, Android met DAVx⁵, Thunderbird):
//    inloggen met HTTP Basic, gebruikersnaam = het inlogmailadres, wachtwoord =
//    een app-wachtwoord uit Instellingen → Agenda. Lezen, maken, wijzigen,
//    verwijderen en alleen de wijzigingen ophalen (sync-collection).
// 2. Deellinks: GET /feed/<token>.ics geeft één ResoFly-agenda als .ics, voor
//    Google Agenda, Outlook of Apple Agenda van iemand zonder ResoFly. Alleen
//    lezen; wat erin staat ("Bezet" of titel en plaats) koos de eigenaar.
//
// De Worker praat met Supabase via de service-role key en omzeilt dus RLS. Hij
// dwingt zelf af dat elk verzoek binnen één organisatie blijft: bij CalDAV het
// paar (user_id, organization_id) van het app-wachtwoord, bij een deellink de
// organisatie en agenda van die link. Beide komen uit de database, nooit uit
// het verzoek.
//
// Pure regels (iCalendar lezen en schrijven, wat een deellink laat zien) staan
// in logic.ts, met tests.

import {
  type EventRow,
  type FeedDetail,
  type FeedEventRow,
  type ParsedEvent,
  MAX_PUT_BYTES,
  PAGE_SIZE,
  buildFeed,
  feedTokenFromPath,
  icsForEvent,
  multigetUids,
  parseICalEvent,
  postgrestInList,
  sha256Hex,
  unescapeXml,
  xml,
} from './logic.ts';

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

interface Principal {
  userId: string;
  orgId: string;
  email: string;
  appPasswordId: string;
  canWrite: boolean;
}

interface SourceRow {
  id: string;
  organization_id: string;
  user_id: string;
  name: string;
  color: string | null;
  visibility: 'private' | 'organization';
  change_seq: number;
}

interface FeedLinkRow {
  id: string;
  organization_id: string;
  source_id: string;
  user_id: string;
  detail: FeedDetail;
  source_name: string;
  last_used_at: string | null;
}

const REALM = 'ResoFly CalDAV';
const XMLNS = 'xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:ICAL="http://apple.com/ns/ical/"';

// Een deellink toont afspraken tot een jaar terug, en alle herhalende. Ouder is
// voor wie meekijkt niet nuttig, en maakte het bestand van een volle agenda
// elk uur weer groter.
const FEED_HISTORY_DAYS = 365;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (err) {
      console.error('caldav error', err instanceof Error ? err.message : String(err));
      return new Response('Internal Server Error', { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

async function handle(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  const url = new URL(request.url);
  let segments: string[];
  try {
    segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  // OPTIONS adverteert de mogelijkheden en mag zonder inloggen (clients pollen dit).
  if (method === 'OPTIONS') return optionsResponse();

  // Zoekmachines horen hier niets op te halen: een deellink is een sleutel.
  if (segments.length === 1 && segments[0] === 'robots.txt') {
    return new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  // Deellinks: het token in het adres is de sleutel, er komt geen inlog bij.
  if (segments[0] === 'feed') return await serveFeed(request, env, segments);

  const principal = await authenticate(request, env);
  if (!principal) return unauthorized();

  // .well-known/caldav en de root geven het principal-pad terug.
  const isServiceRoot = segments.length === 0 || (segments[0] === '.well-known' && segments[1] === 'caldav');
  if (isServiceRoot) {
    if (method === 'PROPFIND') return multiStatus(principalResponse(principal));
    return new Response(null, { status: 301, headers: { Location: principalHref(principal.userId) } });
  }

  // /principals/{userId}/
  if (segments[0] === 'principals') {
    if (segments[1] !== principal.userId) return forbidden();
    if (method === 'PROPFIND') return multiStatus(principalResponse(principal));
    return methodNotAllowed();
  }

  // /calendars/{userId}/...
  if (segments[0] === 'calendars') {
    if (segments[1] !== principal.userId) return forbidden();

    // Home: /calendars/{userId}/
    if (segments.length === 2) {
      if (method !== 'PROPFIND') return methodNotAllowed();
      const sources = await fetchSources(env, principal);
      const depth = request.headers.get('Depth') ?? '0';
      const responses = [homeResponse(principal)];
      if (depth !== '0') for (const s of sources) responses.push(collectionResponse(principal, s, sourceWritable(s, principal)));
      return multiStatus(responses.join(''));
    }

    const sourceId = segments[2];
    const source = await fetchSource(env, principal, sourceId);
    if (!source) return new Response('Not Found', { status: 404 });

    // Collection: /calendars/{userId}/{sourceId}/
    if (segments.length === 3) {
      if (method === 'PROPFIND') {
        const depth = request.headers.get('Depth') ?? '0';
        const responses = [collectionResponse(principal, source, sourceWritable(source, principal))];
        if (depth !== '0') {
          const events = await fetchEvents(env, source);
          for (const ev of events) responses.push(eventResponse(principal, source, ev, false));
        }
        return multiStatus(responses.join(''));
      }
      if (method === 'REPORT') return await report(request, env, principal, source);
      if (method === 'PROPPATCH') return await proppatch(request, env, principal, source);
      return methodNotAllowed();
    }

    // Event: /calendars/{userId}/{sourceId}/{uid}.ics
    if (segments.length === 4) {
      const uid = segments[3].replace(/\.ics$/i, '');
      if (!uid || uid.length > 255) return new Response('Not Found', { status: 404 });
      if (method === 'PUT') return await putEvent(request, env, principal, source, uid);
      const ev = await fetchEvent(env, source, uid);
      if (method === 'DELETE') {
        if (!ev) return new Response('Not Found', { status: 404 });
        return await deleteEvent(request, env, principal, source, ev);
      }
      if (!ev) return new Response('Not Found', { status: 404 });
      if (method === 'GET' || method === 'HEAD') {
        const body = icsForEvent(ev);
        return new Response(method === 'HEAD' ? null : body, {
          status: 200,
          headers: { 'Content-Type': 'text/calendar; charset=utf-8', ETag: quote(ev.etag) },
        });
      }
      if (method === 'PROPFIND') return multiStatus(eventResponse(principal, source, ev, false));
      return methodNotAllowed();
    }
  }

  return new Response('Not Found', { status: 404 });
}

/* ── Inloggen (CalDAV) ────────────────────────────────────────────────── */

async function authenticate(request: Request, env: Env): Promise<Principal | null> {
  const creds = parseBasicAuth(request.headers.get('Authorization'));
  if (!creds) return null;
  // De lookup geeft alleen rijen van ACTIEVE leden, met calendar_level = het
  // effectieve recht op de module Agenda ('read' | 'write'; 'none' komt niet mee).
  // Een oudere versie van de functie kende calendar_level nog niet: dan geldt de rol.
  const rows = await rpc<{
    id: string; user_id: string; organization_id: string; salt: string; password_hash: string;
    role: string | null; calendar_level?: string | null;
  }[]>(env, 'caldav_lookup_app_passwords', { p_email: creds.user });
  const normalized = normalizeToken(creds.pass);
  for (const row of rows) {
    if (!row.role || row.calendar_level === 'none') continue;
    const hash = await sha256Hex(`${row.salt}:${normalized}`);
    if (timingSafeEqualHex(hash, row.password_hash)) {
      // last_used_at bijwerken (best-effort, blokkeert de respons niet).
      void patchLastUsed(env, 'calendar_app_passwords', row.id);
      const writeRole = row.role === 'owner' || row.role === 'admin' || row.role === 'member';
      const canWrite = writeRole && (row.calendar_level ?? 'write') === 'write';
      return { userId: row.user_id, orgId: row.organization_id, email: creds.user, appPasswordId: row.id, canWrite };
    }
  }
  return null;
}

function parseBasicAuth(header: string | null): { user: string; pass: string } | null {
  if (!header || !/^Basic\s+/i.test(header)) return null;
  try {
    // atob geeft bytes als tekens; een mailadres met een é kwam zo verminkt aan.
    const binary = atob(header.replace(/^Basic\s+/i, '').trim());
    const decoded = new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

function normalizeToken(token: string): string {
  return token.replace(/[\s-]/g, '').toLowerCase();
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/* ── Supabase REST ────────────────────────────────────────────────────── */

function restHeaders(env: Env): HeadersInit {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function rpc<T>(env: Env, fn: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: restHeaders(env),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`rpc ${fn} ${res.status}: ${await res.text().catch(() => '')}`);
  return await res.json() as T;
}

/** Alle rijen, per blok van PAGE_SIZE: Supabase geeft er per verzoek niet meer. */
async function fetchAll<T>(env: Env, table: string, query: string): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${query}&limit=${PAGE_SIZE}&offset=${offset}`, { headers: restHeaders(env) });
    if (!res.ok) throw new Error(`${table} ${res.status}`);
    const rows = await res.json() as T[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) return out;
  }
}

async function fetchSources(env: Env, principal: Principal): Promise<SourceRow[]> {
  const query = `provider=eq.native&organization_id=eq.${principal.orgId}` +
    `&or=(user_id.eq.${principal.userId},visibility.eq.organization)&order=name.asc`;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/calendar_sources?${query}`, { headers: restHeaders(env) });
  if (!res.ok) throw new Error(`sources ${res.status}`);
  return await res.json() as SourceRow[];
}

async function fetchSource(env: Env, principal: Principal, sourceId: string): Promise<SourceRow | null> {
  if (!isUuid(sourceId)) return null;
  const query = `id=eq.${sourceId}&provider=eq.native&organization_id=eq.${principal.orgId}` +
    `&or=(user_id.eq.${principal.userId},visibility.eq.organization)`;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/calendar_sources?${query}`, { headers: restHeaders(env) });
  if (!res.ok) return null;
  const rows = await res.json() as SourceRow[];
  return rows[0] ?? null;
}

// Elke afspraak-query filtert ook op de organisatie van de agenda. De agenda
// is al binnen de organisatie gevonden; dit is de tweede grendel, voor als
// iemand hier later een andere bron in steekt.
function eventScope(source: SourceRow): string {
  return `source_id=eq.${source.id}&organization_id=eq.${source.organization_id}`;
}

function fetchEvents(env: Env, source: SourceRow): Promise<EventRow[]> {
  return fetchAll<EventRow>(env, 'calendar_events', `${eventScope(source)}&deleted_at=is.null&order=starts_at.asc,id.asc`);
}

async function fetchEvent(env: Env, source: SourceRow, uid: string, { includeDeleted = false } = {}): Promise<EventRow | null> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/calendar_events?${eventScope(source)}&uid=eq.${encodeURIComponent(uid)}${includeDeleted ? '' : '&deleted_at=is.null'}`,
    { headers: restHeaders(env) },
  );
  if (!res.ok) return null;
  const rows = await res.json() as EventRow[];
  return rows[0] ?? null;
}

/**
 * Een multiget in blokken van 50. Eerst ging er per afspraak een eigen verzoek
 * naar de database: na het eerste koppelen vraagt een iPhone alles tegelijk op,
 * en bij een volle agenda liep de Worker dan tegen zijn grens van verzoeken.
 */
async function fetchEventsByUids(env: Env, source: SourceRow, uids: string[]): Promise<EventRow[]> {
  const out: EventRow[] = [];
  for (let i = 0; i < uids.length; i += 50) {
    const list = encodeURIComponent(postgrestInList(uids.slice(i, i + 50)));
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/calendar_events?${eventScope(source)}&deleted_at=is.null&uid=in.${list}`, { headers: restHeaders(env) });
    if (!res.ok) throw new Error(`multiget ${res.status}`);
    out.push(...await res.json() as EventRow[]);
  }
  return out;
}

async function patchLastUsed(env: Env, table: 'calendar_app_passwords' | 'calendar_feed_links', id: string): Promise<void> {
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
      method: 'PATCH',
      headers: { ...restHeaders(env), Prefer: 'return=minimal' },
      body: JSON.stringify({ last_used_at: new Date().toISOString() }),
    });
  } catch {
    // best-effort
  }
}

/* ── REPORT (calendar-query / calendar-multiget) ──────────────────────── */

async function report(request: Request, env: Env, principal: Principal, source: SourceRow): Promise<Response> {
  const body = await request.text();
  if (/sync-collection/i.test(body)) return await syncCollection(env, principal, source, body);
  if (/calendar-multiget/i.test(body)) {
    const events = await fetchEventsByUids(env, source, multigetUids(body));
    return multiStatus(events.map(ev => eventResponse(principal, source, ev, true)).join(''));
  }
  // calendar-query: alle (niet-verwijderde) afspraken; de client vouwt
  // herhalingen zelf uit en filtert zelf op tijdvenster. De inhoud alleen als
  // de client erom vraagt: een iPhone vraagt eerst alleen de etags, en haalt
  // daarna met een multiget op wat nieuw is.
  const wantsData = /calendar-data/i.test(body);
  const events = await fetchEvents(env, source);
  return multiStatus(events.map(ev => eventResponse(principal, source, ev, wantsData)).join(''));
}

/* ── PROPFIND-responses ───────────────────────────────────────────────── */

function principalHref(userId: string): string {
  return `/principals/${encodeURIComponent(userId)}/`;
}
function homeHref(userId: string): string {
  return `/calendars/${encodeURIComponent(userId)}/`;
}
function collectionHref(userId: string, sourceId: string): string {
  return `/calendars/${encodeURIComponent(userId)}/${encodeURIComponent(sourceId)}/`;
}
function eventHref(userId: string, sourceId: string, uid: string): string {
  return `/calendars/${encodeURIComponent(userId)}/${encodeURIComponent(sourceId)}/${encodeURIComponent(uid)}.ics`;
}

function principalResponse(principal: Principal): string {
  const href = principalHref(principal.userId);
  const prop =
    `<D:resourcetype><D:principal/></D:resourcetype>` +
    `<D:displayname>${xml(principal.email)}</D:displayname>` +
    `<D:current-user-principal><D:href>${href}</D:href></D:current-user-principal>` +
    `<D:principal-URL><D:href>${href}</D:href></D:principal-URL>` +
    `<C:calendar-home-set><D:href>${homeHref(principal.userId)}</D:href></C:calendar-home-set>` +
    `<C:calendar-user-address-set><D:href>mailto:${xml(principal.email)}</D:href></C:calendar-user-address-set>`;
  return responseXml(href, prop);
}

function homeResponse(principal: Principal): string {
  const prop =
    `<D:resourcetype><D:collection/></D:resourcetype>` +
    `<D:displayname>Agenda's</D:displayname>` +
    `<D:current-user-principal><D:href>${principalHref(principal.userId)}</D:href></D:current-user-principal>` +
    `<C:calendar-home-set><D:href>${homeHref(principal.userId)}</D:href></C:calendar-home-set>`;
  return responseXml(homeHref(principal.userId), prop);
}

function collectionResponse(principal: Principal, source: SourceRow, writable: boolean): string {
  const color = normalizeColor(source.color);
  const writePrivs = writable
    ? `<D:privilege><D:write/></D:privilege>` +
      `<D:privilege><D:write-content/></D:privilege>` +
      `<D:privilege><D:bind/></D:privilege>` +
      `<D:privilege><D:unbind/></D:privilege>`
    : '';
  const prop =
    `<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>` +
    `<D:displayname>${xml(source.name)}</D:displayname>` +
    `<C:calendar-description>${xml(source.name)}</C:calendar-description>` +
    (color ? `<ICAL:calendar-color>${color}</ICAL:calendar-color>` : '') +
    `<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>` +
    `<CS:getctag>${quote('ctag-' + source.change_seq)}</CS:getctag>` +
    `<D:sync-token>${syncToken(source.change_seq)}</D:sync-token>` +
    `<D:supported-report-set>` +
      `<D:supported-report><D:report><C:calendar-query/></D:report></D:supported-report>` +
      `<D:supported-report><D:report><C:calendar-multiget/></D:report></D:supported-report>` +
      `<D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report>` +
    `</D:supported-report-set>` +
    `<D:current-user-privilege-set>` +
      `<D:privilege><D:read/></D:privilege>` +
      `<D:privilege><D:read-current-user-privilege-set/></D:privilege>` +
      writePrivs +
    `</D:current-user-privilege-set>`;
  return responseXml(collectionHref(principal.userId, source.id), prop);
}

function eventResponse(principal: Principal, source: SourceRow, ev: EventRow, includeData: boolean): string {
  const href = eventHref(principal.userId, source.id, ev.uid);
  let prop =
    `<D:resourcetype/>` +
    `<D:getetag>${quote(ev.etag)}</D:getetag>` +
    `<D:getcontenttype>text/calendar; component=vevent</D:getcontenttype>`;
  if (includeData) prop += `<C:calendar-data>${xml(icsForEvent(ev))}</C:calendar-data>`;
  return responseXml(href, prop);
}

function responseXml(href: string, propXml: string): string {
  return `<D:response><D:href>${href}</D:href><D:propstat><D:prop>${propXml}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

function multiStatus(responses: string): Response {
  const body = `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus ${XMLNS}>${responses}</D:multistatus>`;
  return new Response(body, { status: 207, headers: { DAV: '1, 2, 3, calendar-access', 'Content-Type': 'application/xml; charset=utf-8' } });
}

function syncToken(changeSeq: number): string {
  return `https://resofly.com/ns/sync/${changeSeq}`;
}

/* ── Diverse helpers ──────────────────────────────────────────────────── */

const ALLOW_METHODS = 'OPTIONS, GET, HEAD, PROPFIND, REPORT, PUT, DELETE, PROPPATCH';

function optionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      DAV: '1, 2, 3, calendar-access',
      Allow: ALLOW_METHODS,
      'Content-Length': '0',
    },
  });
}

function unauthorized(): Response {
  return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"` } });
}
function forbidden(): Response {
  return new Response('Forbidden', { status: 403 });
}
function methodNotAllowed(): Response {
  return new Response('Method Not Allowed', { status: 405, headers: { Allow: ALLOW_METHODS } });
}

function sourceWritable(source: SourceRow, principal: Principal): boolean {
  return principal.canWrite && (source.user_id === principal.userId || source.visibility === 'organization');
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '')}"`;
}

function normalizeColor(color: string | null): string | null {
  if (!color) return null;
  const hex = color.startsWith('#') ? color : `#${color}`;
  return /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex) ? hex.toUpperCase() : null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/* ── Schrijven (PUT / DELETE / PROPPATCH) ─────────────────────────────── */

async function putEvent(request: Request, env: Env, principal: Principal, source: SourceRow, uid: string): Promise<Response> {
  if (!sourceWritable(source, principal)) return forbidden();
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > MAX_PUT_BYTES) return new Response('Payload Too Large', { status: 413 });
  const body = await request.text();
  if (new TextEncoder().encode(body).length > MAX_PUT_BYTES) return new Response('Payload Too Large', { status: 413 });
  const existing = await fetchEvent(env, source, uid);
  const ifMatch = request.headers.get('If-Match');
  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifNoneMatch && ifNoneMatch.trim() === '*' && existing) return preconditionFailed();
  if (ifMatch && (!existing || !etagMatches(ifMatch, existing.etag))) return preconditionFailed();

  let parsed: ParsedEvent;
  try {
    parsed = parseICalEvent(body);
  } catch (err) {
    return new Response(`Invalid iCalendar: ${err instanceof Error ? err.message : 'parse error'}`, { status: 400 });
  }

  const fields = {
    title: parsed.title,
    description: parsed.description,
    location: parsed.location,
    starts_at: parsed.startsAt,
    ends_at: parsed.endsAt,
    all_day: parsed.allDay,
    timezone: parsed.timezone,
    rrule: parsed.rrule,
    exdate: parsed.exdate,
    recurs: parsed.rrule !== null,
    sequence: parsed.sequence,
    icalendar_raw: body,
  };

  // Een verwijderd item blijft als grafsteen staan (voor sync-collection), en
  // (source_id, uid) is uniek. Zet een client hetzelfde item terug (ongedaan
  // maken op de iPhone, een afspraak terugslepen), dan moet die grafsteen weer
  // tot leven komen: een nieuwe rij liep op de unieke sleutel stuk, en elke
  // nieuwe poging van de client gaf opnieuw een 500.
  const tombstone = existing ? null : await fetchEvent(env, source, uid, { includeDeleted: true });
  const target = existing ?? tombstone;

  const row = target
    ? await mutateEvent(env, `id=eq.${target.id}&organization_id=eq.${source.organization_id}`, 'PATCH', { ...fields, deleted_at: null })
    : await mutateEvent(env, '', 'POST', {
        organization_id: source.organization_id,
        source_id: source.id,
        created_by: principal.userId,
        uid,
        ...fields,
      });

  return new Response(null, { status: existing ? 204 : 201, headers: { ETag: quote(row.etag) } });
}

async function deleteEvent(request: Request, env: Env, principal: Principal, source: SourceRow, ev: EventRow): Promise<Response> {
  if (!sourceWritable(source, principal)) return forbidden();
  const ifMatch = request.headers.get('If-Match');
  if (ifMatch && !etagMatches(ifMatch, ev.etag)) return preconditionFailed();
  // Soft-delete = grafsteen voor sync-collection.
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/calendar_events?id=eq.${ev.id}&organization_id=eq.${source.organization_id}`, {
    method: 'PATCH',
    headers: { ...restHeaders(env), Prefer: 'return=minimal' },
    body: JSON.stringify({ deleted_at: new Date().toISOString(), sequence: (ev.sequence ?? 0) + 1 }),
  });
  // Eerst gaf dit altijd 204, ook als de database weigerde: de telefoon dacht
  // dat de afspraak weg was, en bij de volgende synchronisatie kwam hij terug.
  if (!res.ok) throw new Error(`delete event ${res.status}`);
  return new Response(null, { status: 204 });
}

async function proppatch(request: Request, env: Env, principal: Principal, source: SourceRow): Promise<Response> {
  // Naam en kleur van een agenda zijn van de eigenaar, net als in de app (RLS:
  // alleen de eigenaar wijzigt calendar_sources). Afspraken in een gedeelde
  // agenda mag een collega wel schrijven; de agenda zelf hernoemen niet.
  if (!sourceWritable(source, principal) || source.user_id !== principal.userId) return forbidden();
  const body = await request.text();
  const patch: Record<string, unknown> = {};
  const nameM = body.match(/<[^>]*displayname[^>]*>([^<]*)<\/[^>]*displayname>/i);
  if (nameM && nameM[1].trim()) patch.name = unescapeXml(nameM[1].trim()).slice(0, 120);
  const colorM = body.match(/<[^>]*calendar-color[^>]*>([^<]*)<\/[^>]*calendar-color>/i);
  if (colorM) { const c = normalizeColor(colorM[1].trim()); if (c) patch.color = c.slice(0, 7); }
  if (Object.keys(patch).length) {
    await fetch(`${env.SUPABASE_URL}/rest/v1/calendar_sources?id=eq.${source.id}&organization_id=eq.${source.organization_id}`, {
      method: 'PATCH', headers: { ...restHeaders(env), Prefer: 'return=minimal' }, body: JSON.stringify(patch),
    }).catch(() => {});
  }
  const prop = (nameM ? '<D:displayname/>' : '') + (colorM ? '<ICAL:calendar-color/>' : '');
  const resp = `<D:response><D:href>${collectionHref(principal.userId, source.id)}</D:href><D:propstat><D:prop>${prop}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
  return multiStatus(resp);
}

async function mutateEvent(env: Env, filter: string, method: 'POST' | 'PATCH', payload: Record<string, unknown>): Promise<EventRow> {
  const url = method === 'POST'
    ? `${env.SUPABASE_URL}/rest/v1/calendar_events`
    : `${env.SUPABASE_URL}/rest/v1/calendar_events?${filter}`;
  const res = await fetch(url, {
    method,
    headers: { ...restHeaders(env), Prefer: 'return=representation' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`${method} event ${res.status}: ${await res.text().catch(() => '')}`);
  const rows = await res.json() as EventRow[];
  if (!rows[0]) throw new Error('Geen rij teruggegeven na schrijfactie.');
  return rows[0];
}

function etagMatches(ifMatch: string, etag: string): boolean {
  if (ifMatch.trim() === '*') return true;
  return ifMatch.split(',').some(t => t.trim().replace(/^W\//i, '').replace(/"/g, '') === etag);
}

function preconditionFailed(): Response {
  return new Response('Precondition Failed', { status: 412 });
}

/* ── sync-collection (RFC 6578) ───────────────────────────────────────── */

async function syncCollection(env: Env, principal: Principal, source: SourceRow, body: string): Promise<Response> {
  const tokenMatch = body.match(/<[^>]*sync-token[^>]*>([^<]*)<\/[^>]*sync-token>/i);
  const since = parseSyncToken(tokenMatch ? tokenMatch[1] : '');
  const changed = await fetchChangedEvents(env, source, since);
  const responses = changed.map(ev => {
    if (ev.deleted_at) {
      return `<D:response><D:href>${eventHref(principal.userId, source.id, ev.uid)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`;
    }
    return eventResponse(principal, source, ev, false);
  }).join('');
  const newToken = Math.max(source.change_seq, since, ...changed.map(e => e.sync_rev));
  const xmlBody = `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus ${XMLNS}>${responses}<D:sync-token>${syncToken(newToken)}</D:sync-token></D:multistatus>`;
  return new Response(xmlBody, { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}

function parseSyncToken(raw: string): number {
  const m = raw.trim().match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : 0;
}

function fetchChangedEvents(env: Env, source: SourceRow, since: number): Promise<EventRow[]> {
  let query = `${eventScope(source)}&sync_rev=gt.${since}&order=sync_rev.asc,id.asc`;
  if (since === 0) query += '&deleted_at=is.null'; // eerste synchronisatie: geen grafstenen
  return fetchAll<EventRow>(env, 'calendar_events', query);
}

/* ── Deellinks (GET /feed/<token>.ics) ────────────────────────────────── */

async function serveFeed(request: Request, env: Env, segments: string[]): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD, OPTIONS' } });
  }
  const token = feedTokenFromPath(segments);
  if (!token) return feedNotFound();

  // Alleen de hash staat in de database. De lookup geeft niets terug als de
  // link is ingetrokken, de maker geen actief lid meer is of de Agenda niet
  // meer mag zien, of de agenda niet meer van hem is.
  const rows = await rpc<FeedLinkRow[]>(env, 'calendar_feed_lookup', { p_token_hash: await sha256Hex(token) });
  const link = rows[0];
  if (!link) return feedNotFound();

  // Agenda-apps kijken vaak; één keer per uur bijhouden is genoeg.
  const lastUsed = link.last_used_at ? Date.parse(link.last_used_at) : 0;
  if (!lastUsed || Date.now() - lastUsed > 3_600_000) void patchLastUsed(env, 'calendar_feed_links', link.id);

  const since = new Date(Date.now() - FEED_HISTORY_DAYS * 86_400_000).toISOString();
  const events = await fetchAll<FeedEventRow>(env, 'calendar_events',
    `source_id=eq.${link.source_id}&organization_id=eq.${link.organization_id}&deleted_at=is.null` +
    `&or=${encodeURIComponent(`(recurs.eq.true,ends_at.gte.${since})`)}` +
    '&select=uid,title,location,starts_at,ends_at,all_day,rrule,exdate,icalendar_raw,sequence,updated_at' +
    '&order=starts_at.asc,id.asc');

  const body = buildFeed(link.source_name, events, link.detail === 'details' ? 'details' : 'busy');
  const etag = quote((await sha256Hex(body)).slice(0, 32));
  const headers: Record<string, string> = {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': 'inline; filename="agenda.ics"',
    'Cache-Control': 'private, max-age=300',
    ETag: etag,
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
  };
  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifNoneMatch && etagMatches(ifNoneMatch, etag.replace(/"/g, ''))) return new Response(null, { status: 304, headers });
  return new Response(method === 'HEAD' ? null : body, { status: 200, headers });
}

function feedNotFound(): Response {
  return new Response('Deze agendalink bestaat niet (meer). Vraag de eigenaar van de agenda om een nieuwe.\n', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}
