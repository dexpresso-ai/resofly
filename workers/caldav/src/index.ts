// ResoFly CalDAV-server (Cloudflare Worker) — fase 2: discovery + lezen.
//
// Bedient telefoons (Apple Agenda, Android/DAVx5) read-only met de native
// ResoFly-agenda's. Authenticatie via HTTP Basic (gebruikersnaam = inlog-e-mail,
// wachtwoord = app-wachtwoord). De Worker praat met Supabase via de service-role
// key en dwingt ZELF tenant-isolatie af (RLS wordt omzeild): elke request wordt
// strikt beperkt tot het geauthenticeerde paar (user_id, organization_id).
//
// Schrijven (PUT/DELETE), sync-collection en herhaling-parsing komen in fase 3.

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

interface Principal {
  userId: string;
  orgId: string;
  email: string;
  appPasswordId: string;
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

interface EventRow {
  id: string;
  source_id: string;
  uid: string;
  icalendar_raw: string | null;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  rrule: string | null;
  sequence: number;
  etag: string;
  updated_at: string;
}

const REALM = 'ResoFly CalDAV';
const XMLNS = 'xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:ICAL="http://apple.com/ns/ical/"';

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
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  // OPTIONS adverteert de mogelijkheden en mag zonder auth (clients pollen dit).
  if (method === 'OPTIONS') return optionsResponse();

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
      if (depth !== '0') for (const s of sources) responses.push(collectionResponse(principal, s));
      return multiStatus(responses.join(''));
    }

    const sourceId = segments[2];
    const source = await fetchSource(env, principal, sourceId);
    if (!source) return new Response('Not Found', { status: 404 });

    // Collection: /calendars/{userId}/{sourceId}/
    if (segments.length === 3) {
      if (method === 'PROPFIND') {
        const depth = request.headers.get('Depth') ?? '0';
        const responses = [collectionResponse(principal, source)];
        if (depth !== '0') {
          const events = await fetchEvents(env, source.id);
          for (const ev of events) responses.push(eventResponse(principal, source, ev, false));
        }
        return multiStatus(responses.join(''));
      }
      if (method === 'REPORT') return await report(request, env, principal, source);
      return methodNotAllowed();
    }

    // Event: /calendars/{userId}/{sourceId}/{uid}.ics
    if (segments.length === 4) {
      const uid = segments[3].replace(/\.ics$/i, '');
      const ev = await fetchEvent(env, source.id, uid);
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

/* ── Auth ─────────────────────────────────────────────────────────────── */

async function authenticate(request: Request, env: Env): Promise<Principal | null> {
  const creds = parseBasicAuth(request.headers.get('Authorization'));
  if (!creds) return null;
  const rows = await rpc<{ id: string; user_id: string; organization_id: string; salt: string; password_hash: string }[]>(
    env, 'caldav_lookup_app_passwords', { p_email: creds.user },
  );
  const normalized = normalizeToken(creds.pass);
  for (const row of rows) {
    const hash = await sha256Hex(`${row.salt}:${normalized}`);
    if (timingSafeEqualHex(hash, row.password_hash)) {
      // last_used_at bijwerken (best-effort, blokkeert de respons niet).
      void patchLastUsed(env, row.id);
      return { userId: row.user_id, orgId: row.organization_id, email: creds.user, appPasswordId: row.id };
    }
  }
  return null;
}

function parseBasicAuth(header: string | null): { user: string; pass: string } | null {
  if (!header || !/^Basic\s+/i.test(header)) return null;
  try {
    const decoded = atob(header.replace(/^Basic\s+/i, '').trim());
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

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
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

async function fetchEvents(env: Env, sourceId: string): Promise<EventRow[]> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/calendar_events?source_id=eq.${sourceId}&deleted_at=is.null&order=starts_at.asc`,
    { headers: restHeaders(env) },
  );
  if (!res.ok) throw new Error(`events ${res.status}`);
  return await res.json() as EventRow[];
}

async function fetchEvent(env: Env, sourceId: string, uid: string): Promise<EventRow | null> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/calendar_events?source_id=eq.${sourceId}&uid=eq.${encodeURIComponent(uid)}&deleted_at=is.null`,
    { headers: restHeaders(env) },
  );
  if (!res.ok) return null;
  const rows = await res.json() as EventRow[];
  return rows[0] ?? null;
}

async function patchLastUsed(env: Env, appPasswordId: string): Promise<void> {
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/calendar_app_passwords?id=eq.${appPasswordId}`, {
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
  const isMultiget = /calendar-multiget/i.test(body);
  let events: EventRow[];
  if (isMultiget) {
    const hrefs = [...body.matchAll(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/gi)].map(m => m[1].trim());
    const uids = hrefs.map(h => decodeURIComponent(h.split('/').pop() ?? '').replace(/\.ics$/i, '')).filter(Boolean);
    events = [];
    for (const uid of uids) {
      const ev = await fetchEvent(env, source.id, uid);
      if (ev) events.push(ev);
    }
  } else {
    // calendar-query: geef alle (niet-verwijderde) events terug; de client
    // expandeert herhaling en filtert zelf op tijdvenster.
    events = await fetchEvents(env, source.id);
  }
  const responses = events.map(ev => eventResponse(principal, source, ev, true)).join('');
  return multiStatus(responses);
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

function collectionResponse(principal: Principal, source: SourceRow): string {
  const color = normalizeColor(source.color);
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
    `</D:supported-report-set>` +
    // Fase 2 is read-only.
    `<D:current-user-privilege-set>` +
      `<D:privilege><D:read/></D:privilege>` +
      `<D:privilege><D:read-current-user-privilege-set/></D:privilege>` +
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

/* ── iCalendar-generatie ──────────────────────────────────────────────── */

function icsForEvent(ev: EventRow): string {
  if (ev.icalendar_raw && ev.icalendar_raw.trim()) return ev.icalendar_raw;
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ResoFly//CalDAV//NL',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(ev.uid)}`,
    `DTSTAMP:${icsUtc(new Date())}`,
  ];
  if (ev.all_day) {
    const start = new Date(ev.starts_at);
    let endExclusive = new Date(ev.ends_at);
    if (endExclusive.getTime() <= start.getTime()) endExclusive = addUtcDays(start, 1);
    lines.push(`DTSTART;VALUE=DATE:${icsDate(start)}`);
    lines.push(`DTEND;VALUE=DATE:${icsDate(endExclusive)}`);
  } else {
    lines.push(`DTSTART:${icsUtc(new Date(ev.starts_at))}`);
    lines.push(`DTEND:${icsUtc(new Date(ev.ends_at))}`);
  }
  lines.push(`SUMMARY:${escapeIcsText(ev.title || '(Geen titel)')}`);
  if (ev.description) lines.push(`DESCRIPTION:${escapeIcsText(ev.description)}`);
  if (ev.location) lines.push(`LOCATION:${escapeIcsText(ev.location)}`);
  if (ev.rrule) lines.push(`RRULE:${ev.rrule}`);
  lines.push(`SEQUENCE:${Number.isFinite(ev.sequence) ? ev.sequence : 0}`);
  lines.push(`LAST-MODIFIED:${icsUtc(new Date(ev.updated_at))}`);
  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

function icsUtc(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}

function icsDate(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}`;
}

function addUtcDays(date: Date, days: number): Date {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function escapeIcsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// RFC 5545 line folding: regels langer dan 75 octets vouwen met CRLF + spatie.
function foldIcsLine(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let remaining = line;
  parts.push(remaining.slice(0, 75));
  remaining = remaining.slice(75);
  while (remaining.length > 74) {
    parts.push(' ' + remaining.slice(0, 74));
    remaining = remaining.slice(74);
  }
  if (remaining.length) parts.push(' ' + remaining);
  return parts.join('\r\n');
}

/* ── Diverse helpers ──────────────────────────────────────────────────── */

function optionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      DAV: '1, 2, 3, calendar-access',
      Allow: 'OPTIONS, GET, HEAD, PROPFIND, REPORT',
      'Content-Length': '0',
    },
  });
}

function unauthorized(): Response {
  return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': `Basic realm="${REALM}"` } });
}
function forbidden(): Response {
  return new Response('Forbidden', { status: 403 });
}
function methodNotAllowed(): Response {
  return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'OPTIONS, GET, HEAD, PROPFIND, REPORT' } });
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

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
