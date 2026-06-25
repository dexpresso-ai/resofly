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
  sync_rev: number;
  deleted_at: string | null;
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
          const events = await fetchEvents(env, source.id);
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
      if (method === 'PUT') return await putEvent(request, env, principal, source, uid);
      const ev = await fetchEvent(env, source.id, uid);
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

/* ── Auth ─────────────────────────────────────────────────────────────── */

async function authenticate(request: Request, env: Env): Promise<Principal | null> {
  const creds = parseBasicAuth(request.headers.get('Authorization'));
  if (!creds) return null;
  const rows = await rpc<{ id: string; user_id: string; organization_id: string; salt: string; password_hash: string; role: string | null }[]>(
    env, 'caldav_lookup_app_passwords', { p_email: creds.user },
  );
  const normalized = normalizeToken(creds.pass);
  for (const row of rows) {
    const hash = await sha256Hex(`${row.salt}:${normalized}`);
    if (timingSafeEqualHex(hash, row.password_hash)) {
      // last_used_at bijwerken (best-effort, blokkeert de respons niet).
      void patchLastUsed(env, row.id);
      const canWrite = row.role === 'owner' || row.role === 'admin' || row.role === 'member';
      return { userId: row.user_id, orgId: row.organization_id, email: creds.user, appPasswordId: row.id, canWrite };
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
  if (/sync-collection/i.test(body)) return await syncCollection(env, principal, source, body);
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
  return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': `Basic realm="${REALM}"` } });
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

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unescapeXml(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/* ── Schrijven (PUT / DELETE / PROPPATCH) ─────────────────────────────── */

async function putEvent(request: Request, env: Env, principal: Principal, source: SourceRow, uid: string): Promise<Response> {
  if (!sourceWritable(source, principal)) return forbidden();
  const body = await request.text();
  const existing = await fetchEvent(env, source.id, uid);
  const ifMatch = request.headers.get('If-Match');
  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifNoneMatch && ifNoneMatch.trim() === '*' && existing) return preconditionFailed();
  if (ifMatch && (!existing || !etagMatches(ifMatch, existing.etag))) return preconditionFailed();

  let parsed: ParsedEvent;
  try {
    parsed = parseICalEvent(body, uid);
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

  const row = existing
    ? await mutateEvent(env, `id=eq.${existing.id}`, 'PATCH', { ...fields, deleted_at: null })
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
  // Soft-delete = tombstone voor sync-collection.
  await fetch(`${env.SUPABASE_URL}/rest/v1/calendar_events?id=eq.${ev.id}`, {
    method: 'PATCH',
    headers: { ...restHeaders(env), Prefer: 'return=minimal' },
    body: JSON.stringify({ deleted_at: new Date().toISOString(), sequence: (ev.sequence ?? 0) + 1 }),
  });
  return new Response(null, { status: 204 });
}

async function proppatch(request: Request, env: Env, principal: Principal, source: SourceRow): Promise<Response> {
  if (!sourceWritable(source, principal)) return forbidden();
  const body = await request.text();
  const patch: Record<string, unknown> = {};
  const nameM = body.match(/<[^>]*displayname[^>]*>([^<]*)<\/[^>]*displayname>/i);
  if (nameM && nameM[1].trim()) patch.name = unescapeXml(nameM[1].trim()).slice(0, 120);
  const colorM = body.match(/<[^>]*calendar-color[^>]*>([^<]*)<\/[^>]*calendar-color>/i);
  if (colorM) { const c = normalizeColor(colorM[1].trim()); if (c) patch.color = c.slice(0, 7); }
  if (Object.keys(patch).length) {
    await fetch(`${env.SUPABASE_URL}/rest/v1/calendar_sources?id=eq.${source.id}`, {
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
  const changed = await fetchChangedEvents(env, source.id, since);
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

async function fetchChangedEvents(env: Env, sourceId: string, since: number): Promise<EventRow[]> {
  let query = `source_id=eq.${sourceId}&sync_rev=gt.${since}&order=sync_rev.asc`;
  if (since === 0) query += '&deleted_at=is.null'; // initiële sync: geen tombstones
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/calendar_events?${query}`, { headers: restHeaders(env) });
  if (!res.ok) throw new Error(`changed ${res.status}`);
  return await res.json() as EventRow[];
}

/* ── iCalendar-parser (projectie uit de canonieke tekst) ──────────────── */

interface ParsedEvent {
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  timezone: string | null;
  rrule: string | null;
  exdate: string[] | null;
  sequence: number;
}

interface IcsProp { name: string; params: Record<string, string>; value: string }

function parseICalEvent(text: string, fallbackUid: string): ParsedEvent {
  const lines = unfoldIcs(text);
  const blocks: IcsProp[][] = [];
  let current: IcsProp[] | null = null;
  for (const line of lines) {
    if (/^BEGIN:VEVENT\s*$/i.test(line)) { current = []; continue; }
    if (/^END:VEVENT\s*$/i.test(line)) { if (current) blocks.push(current); current = null; continue; }
    if (current) { const p = parsePropLine(line); if (p) current.push(p); }
  }
  if (!blocks.length) throw new Error('geen VEVENT gevonden');
  // De hoofd-instantie = de VEVENT zonder RECURRENCE-ID.
  const master = blocks.find(b => !b.some(p => p.name === 'RECURRENCE-ID')) ?? blocks[0];
  const get = (n: string) => master.find(p => p.name === n);

  const start = parseIcsTime(get('DTSTART'));
  const dtend = get('DTEND');
  let endsAt: string;
  if (dtend) {
    endsAt = parseIcsTime(dtend).iso;
  } else {
    const dur = get('DURATION');
    const ms = dur ? parseDurationMs(dur.value) : (start.allDay ? 86400000 : 3600000);
    endsAt = new Date(new Date(start.iso).getTime() + ms).toISOString();
  }

  const exdateValues: string[] = [];
  for (const p of master) {
    if (p.name !== 'EXDATE') continue;
    for (const part of p.value.split(',')) {
      const t = parseIcsTime({ name: 'EXDATE', params: p.params, value: part });
      exdateValues.push(t.iso);
    }
  }

  const rrule = get('RRULE')?.value?.trim().toUpperCase() || null;

  return {
    title: unescapeText(get('SUMMARY')?.value ?? '') || '(Geen titel)',
    description: get('DESCRIPTION') ? unescapeText(get('DESCRIPTION')!.value) : null,
    location: get('LOCATION') ? unescapeText(get('LOCATION')!.value) : null,
    startsAt: start.iso,
    endsAt,
    allDay: start.allDay,
    timezone: start.tzid,
    rrule,
    exdate: exdateValues.length ? exdateValues : null,
    sequence: parseInt(get('SEQUENCE')?.value ?? '0', 10) || 0,
  };
}

function unfoldIcs(text: string): string[] {
  const raw = text.split(/\r\n|\n|\r/);
  const lines: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

function parsePropLine(line: string): IcsProp | null {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segs = left.split(';');
  const name = segs[0].toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (let i = 1; i < segs.length; i++) {
    const eq = segs[i].indexOf('=');
    if (eq > 0) params[segs[i].slice(0, eq).toUpperCase()] = segs[i].slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

function parseIcsTime(prop: IcsProp | undefined): { iso: string; allDay: boolean; tzid: string | null } {
  if (!prop || !prop.value) return { iso: new Date().toISOString(), allDay: false, tzid: null };
  const value = prop.value.trim();
  // All-day: VALUE=DATE of een kale YYYYMMDD.
  if (prop.params.VALUE === 'DATE' || /^\d{8}$/.test(value)) {
    const m = value.match(/^(\d{4})(\d{2})(\d{2})/);
    if (m) return { iso: `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`, allDay: true, tzid: null };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) {
    const fallback = new Date(value);
    return { iso: Number.isNaN(fallback.getTime()) ? new Date().toISOString() : fallback.toISOString(), allDay: false, tzid: null };
  }
  const [, y, mo, d, h, mi, s, z] = m;
  if (z === 'Z') {
    return { iso: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)).toISOString(), allDay: false, tzid: null };
  }
  const tzid = prop.params.TZID || null;
  if (tzid) {
    return { iso: wallTimeToUtcIso(+y, +mo, +d, +h, +mi, +s, tzid), allDay: false, tzid };
  }
  // Zwevende tijd (geen zone): behandel als UTC (best-effort).
  return { iso: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)).toISOString(), allDay: false, tzid: null };
}

// Wandkloktijd in een IANA-zone → UTC-ISO, via Intl (handelt zomertijd af).
function wallTimeToUtcIso(y: number, mo: number, d: number, h: number, mi: number, s: number, tzid: string): string {
  try {
    const guess = Date.UTC(y, mo - 1, d, h, mi, s);
    const offset1 = tzOffsetMs(guess, tzid);
    let utc = guess - offset1;
    const offset2 = tzOffsetMs(utc, tzid);
    if (offset2 !== offset1) utc = guess - offset2;
    return new Date(utc).toISOString();
  } catch {
    return new Date(Date.UTC(y, mo - 1, d, h, mi, s)).toISOString();
  }
}

function tzOffsetMs(utcMs: number, tzid: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tzid, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const map: Record<string, number> = {};
  for (const p of parts) if (p.type !== 'literal') map[p.type] = parseInt(p.value, 10);
  const asUtc = Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second);
  return asUtc - utcMs;
}

function parseDurationMs(value: string): number {
  const m = value.trim().match(/^([+-]?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!m) return 3600000;
  const sign = m[1] === '-' ? -1 : 1;
  const w = +(m[2] || 0), d = +(m[3] || 0), h = +(m[4] || 0), mi = +(m[5] || 0), s = +(m[6] || 0);
  return sign * ((((w * 7 + d) * 24 + h) * 60 + mi) * 60 + s) * 1000;
}

function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}
