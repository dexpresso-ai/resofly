// ============================================================
// Agenda's via link (iCal/ICS-abonnementen) — ophalen, parsen, cachen
//
// Een ICS-abonnement is een read-only agenda die de gebruiker toevoegt met een
// iCal/ICS-URL (Google "geheime iCal-link", Outlook gepubliceerde .ics, iCloud,
// of een andere feed). Deze module:
//   1) haalt de feed SSRF-gehard op (alleen https, geen privé-IP's, size/tijd-cap,
//      handmatige redirect-validatie) met conditionele GET (ETag / content-hash);
//   2) parseert het iCalendar met ical.js (robuuste RRULE-uitvouwing + overrides);
//   3) vouwt herhalingen uit tot losse instances binnen een venster en cachet ze
//      als gewone rijen in calendar_events (dezelfde tabel als native agenda's).
//
// Tijdzones: we lezen de WANDKLOK-velden uit ical.js en rekenen zelf om naar UTC
// met Intl (Deno's IANA-tz-database). Zo hoeven we geen VTIMEZONE te registreren
// (waarvan de ical.js-API per versie verschilt) en klopt DST per datum.
// ============================================================

// @ts-ignore — esm.sh levert de typedefs niet mee; runtime-import is voldoende.
import ICAL from 'https://esm.sh/ical.js@2.1.0';
import { type CalendarSourceRow, supabaseAdmin, normalizeAllDayEventRange } from './calendarCore.ts';

const MAX_FEED_BYTES = 5 * 1024 * 1024;      // 5 MB harde limiet op de feed
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const WINDOW_PAST_DAYS = 120;                 // hoe ver terug we instances bewaren
const WINDOW_FUTURE_DAYS = 400;               // hoe ver vooruit we uitvouwen
const MAX_INSTANCES_PER_EVENT = 800;          // rem tegen ontplofte herhalingen
const MAX_ROWS_PER_FEED = 5_000;              // rem op totale feed-omvang
const TITLE_MAX = 300;
const TEXT_MAX = 8_000;

export type IcsEventRow = {
  uid: string;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
};

export type IcsSyncResult = { changed: boolean; count: number; skippedReason?: string };

// ── SSRF-guard ──────────────────────────────────────────────────────────────

/**
 * Valideert en normaliseert een door de gebruiker aangeleverde feed-URL.
 * - alleen https (webcal:// wordt naar https:// herschreven);
 * - alleen de standaard https-poort (geen interne diensten op rare poorten);
 * - blokkeert IP-literals in privé-/loopback-/link-local-/reserved-bereik en
 *   bekende hostnamen (localhost, *.local, *.internal);
 * - probeert DNS te resolven en blokkeert privé-IP's (best-effort: niet elke
 *   runtime staat Deno.resolveDns toe — dan vallen we terug op de host-checks).
 * Retourneert de genormaliseerde https-URL.
 */
export async function assertSafeFeedUrl(raw: string): Promise<string> {
  const trimmed = (raw || '').trim();
  if (!trimmed) throw new Error('Geen agenda-link opgegeven.');
  let url: URL;
  try {
    url = new URL(trimmed.replace(/^webcal:\/\//i, 'https://'));
  } catch {
    throw new Error('Dit is geen geldige link.');
  }
  if (url.protocol !== 'https:') throw new Error('Alleen https-agendalinks zijn toegestaan.');
  if (url.port && url.port !== '443') throw new Error('Alleen de standaard https-poort is toegestaan.');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) throw new Error('De link mist een hostnaam.');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Deze link verwijst naar een intern adres.');
  }
  // Alternatieve IP-coderingen weren die de dotted-quad-check omzeilen: hex
  // (0x7f000001), decimaal (2130706433) en octaal (0177.0.0.1). Echte feed-hosts
  // zijn óf een domeinnaam (met letters), óf een net dotted-quad, óf IPv6 [..].
  if (/0x/i.test(host)) throw new Error('Hexadecimale adressen zijn niet toegestaan.');
  const isDottedQuad = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const isBracketedV6 = host.startsWith('[');
  if (!isDottedQuad && !isBracketedV6 && !/[a-z]/i.test(host)) {
    throw new Error('Dit numerieke adres is niet toegestaan.');
  }
  // IP-literal? (host tussen [] is IPv6.)
  const ipLiteral = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIpLiteral(ipLiteral)) {
    if (isDisallowedIp(ipLiteral)) throw new Error('Deze link verwijst naar een intern of gereserveerd adres.');
  } else {
    // Hostnaam: probeer te resolven en elk privé-IP te weren (best-effort).
    for (const record of ['A', 'AAAA'] as const) {
      let ips: string[] = [];
      try { ips = await Deno.resolveDns(host, record); }
      catch { /* runtime staat resolveDns niet toe of geen record — sla over */ continue; }
      for (const ip of ips) {
        if (isDisallowedIp(ip)) throw new Error('Deze link verwijst (via DNS) naar een intern adres.');
      }
    }
  }
  return url.toString();
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/** True voor een niet-routeerbaar/gereserveerd IPv4-octet-viertal. */
function isDisallowedV4(o: number[]): boolean {
  if (o.length !== 4 || o.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = o;
  if (a === 0 || a === 10 || a === 127) return true;                 // this-net, private, loopback
  if (a === 169 && b === 254) return true;                            // link-local incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;                   // private
  if (a === 192 && b === 168) return true;                            // private
  if (a === 100 && b >= 64 && b <= 127) return true;                  // CGNAT 100.64/10
  if (a === 192 && b === 0 && c === 0) return true;                   // 192.0.0.0/24
  if (a >= 224) return true;                                          // multicast + reserved
  return false;
}

/**
 * Decodeert een IPv6-literal (evt. met ingebedde IPv4-staart) naar 16 bytes.
 * De WHATWG-URL-parser normaliseert `[::ffff:127.0.0.1]` naar `::ffff:7f00:1`,
 * dus we mogen niet op de tekstvorm vertrouwen — we ontleden naar bytes.
 */
function ipv6ToBytes(input: string): number[] | null {
  let s = input.toLowerCase().replace(/^\[|\]$/g, '');
  // Ingebedde IPv4-staart (a.b.c.d) → twee hex-groepen.
  if (s.includes('.')) {
    const idx = s.lastIndexOf(':');
    if (idx < 0) return null;
    const m = s.slice(idx + 1).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return null;
    const o = m.slice(1).map(Number);
    if (o.some(n => n > 255)) return null;
    s = s.slice(0, idx + 1) + (((o[0] << 8) | o[1]).toString(16)) + ':' + (((o[2] << 8) | o[3]).toString(16));
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups: string[];
  if (tail === null) { groups = head; }
  else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  }
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes;
}

/** True voor loopback/private/link-local/ULA/CGNAT/multicast/reserved adressen. */
export function isDisallowedIp(ip: string): boolean {
  const addr = ip.toLowerCase();
  const v4 = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) return isDisallowedV4(v4.slice(1).map(Number));
  if (addr.includes(':')) {
    const b = ipv6ToBytes(addr);
    if (!b) return true; // onparseerbaar → weigeren
    const zero = (from: number, to: number) => b.slice(from, to).every(x => x === 0);
    if (zero(0, 15) && (b[15] === 0 || b[15] === 1)) return true;      // :: en ::1
    if ((b[0] & 0xfe) === 0xfc) return true;                          // ULA fc00::/7
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;         // link-local fe80::/10
    if (b[0] === 0xff) return true;                                   // multicast
    // Ingebedde IPv4: mapped ::ffff:0:0/96, compat ::/96, NAT64 64:ff9b::/96, 6to4 2002::/16.
    if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return isDisallowedV4(b.slice(12));
    if (zero(0, 12)) return isDisallowedV4(b.slice(12));
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return isDisallowedV4(b.slice(12));
    if (b[0] === 0x20 && b[1] === 0x02) return isDisallowedV4(b.slice(2, 6));
    return false; // overige = publiek unicast
  }
  return true; // onbekend formaat → weigeren
}

// ── Ophalen (conditioneel, gecapt, redirect-gevalideerd) ────────────────────

type FetchResult = { status: number; body: string; etag: string | null };

async function fetchIcsFeed(startUrl: string, priorEtag: string | null): Promise<FetchResult> {
  let current = await assertSafeFeedUrl(startUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const headers: Record<string, string> = {
        Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5',
        'User-Agent': 'ResoFly-Calendar/1.0 (+ics-subscription)',
      };
      if (priorEtag && hop === 0) headers['If-None-Match'] = priorEtag;
      const res = await fetch(current, { redirect: 'manual', signal: controller.signal, headers });
      if (res.status === 304) { await res.body?.cancel(); return { status: 304, body: '', etag: priorEtag }; }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await res.body?.cancel();
        if (!location) throw new Error('De agenda-link stuurde een ongeldige omleiding.');
        if (hop === MAX_REDIRECTS) throw new Error('De agenda-link stuurt te vaak door.');
        current = await assertSafeFeedUrl(new URL(location, current).toString());
        continue;
      }
      if (!res.ok) { await res.body?.cancel(); throw new Error(`De agenda-link gaf status ${res.status}.`); }
      const body = await readCapped(res, MAX_FEED_BYTES);
      return { status: 200, body, etag: res.headers.get('etag') };
    }
    throw new Error('De agenda-link stuurt te vaak door.');
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new Error('De agenda is te groot (limiet 5 MB).'); }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }
  return new TextDecoder('utf-8').decode(merged);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Tijdzone: wandklok + IANA-tzid → UTC (via Intl) ─────────────────────────

const offsetFmtCache = new Map<string, Intl.DateTimeFormat>();
function offsetFormatter(tzid: string): Intl.DateTimeFormat {
  let fmt = offsetFmtCache.get(tzid);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    offsetFmtCache.set(tzid, fmt);
  }
  return fmt;
}

/** Offset (ms) van de zone t.o.v. UTC op het gegeven UTC-moment. */
function tzOffsetMs(tzid: string, utcMs: number): number {
  const parts = offsetFormatter(tzid).formatToParts(new Date(utcMs));
  const m: Record<string, number> = {};
  for (const p of parts) if (p.type !== 'literal') m[p.type] = Number(p.value);
  const asUtc = Date.UTC(m.year, (m.month || 1) - 1, m.day || 1, m.hour || 0, m.minute || 0, m.second || 0);
  return asUtc - utcMs;
}

/** Wandkloktijd in zone `tzid` → UTC-ISO. Twee passes voor DST-randen. */
function zonedWallClockToUtcIso(y: number, mo: number, d: number, h: number, mi: number, s: number, tzid: string): string {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  let utc = asUtc - tzOffsetMs(tzid, asUtc);
  utc = asUtc - tzOffsetMs(tzid, utc);
  return new Date(utc).toISOString();
}

// ical.js ICAL.Time (met bekende zone/UTC) → UTC-ISO. Retourneert null voor
// hele-dag (VALUE=DATE); die verwerken we apart met normalizeAllDayEventRange.
function icalTimeToUtcIso(t: any, tzid: string | null): string | null {
  if (!t || t.isDate) return null;
  const y = t.year, mo = t.month, d = t.day, h = t.hour || 0, mi = t.minute || 0, s = t.second || 0;
  if (!tzid || tzid === 'UTC' || tzid === 'Z' || tzid === 'floating') {
    return new Date(Date.UTC(y, mo - 1, d, h, mi, s)).toISOString();
  }
  try { return zonedWallClockToUtcIso(y, mo, d, h, mi, s, tzid); }
  catch { return new Date(Date.UTC(y, mo - 1, d, h, mi, s)).toISOString(); }
}

function icalDateKey(t: any): string {
  return `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
}

function zoneTzid(t: any): string | null {
  const z = t?.zone;
  if (!z) return null;
  if (z === ICAL.Timezone.utcTimezone || z === ICAL.Timezone.localTimezone) return z === ICAL.Timezone.utcTimezone ? 'UTC' : 'floating';
  return z.tzid || null;
}

function clip(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

// ── Parsen ──────────────────────────────────────────────────────────────────

/** Parseert iCalendar-tekst tot uitgevouwen event-rijen binnen [winStart, winEnd]. */
export function parseIcsToRows(text: string, winStart: Date, winEnd: Date): IcsEventRow[] {
  let jcal: any;
  try { jcal = ICAL.parse(text); }
  catch { throw new Error('De link gaf geen geldige iCal-agenda terug.'); }
  const root = new ICAL.Component(jcal);
  // Meestal een VCALENDAR met VEVENT-kinderen; tolereer ook een losse VEVENT.
  const vevents = root.name === 'vevent' ? [root] : root.getAllSubcomponents('vevent');
  if (!vevents.length) return [];

  // Masters en losse overrides (RECURRENCE-ID) per UID groeperen.
  const masters = new Map<string, any>();
  const exceptions = new Map<string, any[]>();
  for (const ve of vevents) {
    let ev: any;
    try { ev = new ICAL.Event(ve); } catch { continue; }
    const uid = ev.uid || '';
    if (!uid) { masters.set(`__anon_${masters.size}`, ev); continue; }
    if (ev.isRecurrenceException && ev.isRecurrenceException()) {
      const list = exceptions.get(uid) ?? [];
      list.push(ev);
      exceptions.set(uid, list);
    } else if (!masters.has(uid)) {
      masters.set(uid, ev);
    }
  }

  const rows: IcsEventRow[] = [];
  const winStartMs = winStart.getTime();
  const winEndMs = winEnd.getTime();

  for (const [uid, ev] of masters) {
    if (rows.length >= MAX_ROWS_PER_FEED) break;
    for (const ex of exceptions.get(uid) ?? []) {
      try { ev.relateException(ex); } catch { /* mismatchende override — negeren */ }
    }
    const baseTzid = zoneTzid(ev.startDate);
    const title = clip(ev.summary, TITLE_MAX) ?? '(Geen titel)';
    const description = clip(ev.description, TEXT_MAX);
    const location = clip(ev.location, TEXT_MAX);

    if (ev.isRecurring && ev.isRecurring()) {
      const iterator = ev.iterator();
      let next: any;
      let n = 0;
      while ((next = iterator.next())) {
        if (n++ >= MAX_INSTANCES_PER_EVENT || rows.length >= MAX_ROWS_PER_FEED) break;
        let details: any;
        try { details = ev.getOccurrenceDetails(next); } catch { continue; }
        const startJs = details.startDate.toJSDate();
        if (startJs.getTime() > winEndMs) break;           // iterator loopt vooruit → stop
        const endJs = details.endDate.toJSDate();
        if (endJs.getTime() < winStartMs) continue;         // nog vóór het venster
        const row = buildRow(`${uid}#${details.startDate.toString()}`,
          clip(details.item?.summary, TITLE_MAX) ?? title,
          clip(details.item?.description, TEXT_MAX) ?? description,
          clip(details.item?.location, TEXT_MAX) ?? location,
          details.startDate, details.endDate, baseTzid);
        if (row) rows.push(row);
      }
    } else {
      const startJs = ev.startDate?.toJSDate?.();
      const endJs = ev.endDate?.toJSDate?.();
      if (startJs && endJs && (endJs.getTime() < winStartMs || startJs.getTime() > winEndMs)) continue;
      const row = buildRow(uid, title, description, location, ev.startDate, ev.endDate, baseTzid);
      if (row) rows.push(row);
    }
  }
  return rows;
}

function buildRow(uid: string, title: string, description: string | null, location: string | null,
  start: any, end: any, tzid: string | null): IcsEventRow | null {
  if (!start) return null;
  if (start.isDate) {
    const range = normalizeAllDayEventRange(icalDateKey(start), end ? icalDateKey(end) : null);
    return { uid, title, description, location, starts_at: range.starts_at, ends_at: range.ends_at, all_day: true };
  }
  const startsAt = icalTimeToUtcIso(start, tzid);
  if (!startsAt) return null;
  let endsAt = end ? icalTimeToUtcIso(end, zoneTzid(end) ?? tzid) : null;
  if (!endsAt) endsAt = startsAt; // geen DTEND → nulduur (bv. een markering)
  if (new Date(endsAt).getTime() < new Date(startsAt).getTime()) endsAt = startsAt;
  return { uid: uid.slice(0, 512), title, description, location, starts_at: startsAt, ends_at: endsAt, all_day: false };
}

// ── Sync-orkestratie ────────────────────────────────────────────────────────

/**
 * Haalt de feed van één ICS-bron op en cachet de events in calendar_events.
 * Retourneert of er iets veranderd is + het aantal opgeslagen items.
 * Bij een fout wordt feed_last_error op de bron gezet en de fout doorgegooid
 * (de manuele "Ververs nu"-actie toont die; de cron vangt per bron op).
 */
export async function syncIcsSource(source: CalendarSourceRow, opts: { force?: boolean } = {}): Promise<IcsSyncResult> {
  if (source.provider !== 'ics' || !source.feed_url) throw new Error('Dit is geen agenda-abonnement.');
  try {
    const result = await fetchIcsFeed(source.feed_url, opts.force ? null : source.feed_etag);
    if (result.status === 304) {
      await supabaseAdmin.from('calendar_sources')
        .update({ feed_last_synced_at: new Date().toISOString(), feed_last_error: null }).eq('id', source.id);
      return { changed: false, count: 0, skippedReason: 'not-modified' };
    }
    const hash = await sha256Hex(result.body);
    if (!opts.force && hash === source.feed_content_hash) {
      await supabaseAdmin.from('calendar_sources')
        .update({ feed_last_synced_at: new Date().toISOString(), feed_etag: result.etag, feed_last_error: null }).eq('id', source.id);
      return { changed: false, count: 0, skippedReason: 'unchanged' };
    }

    const now = Date.now();
    const winStart = new Date(now - WINDOW_PAST_DAYS * 864e5);
    const winEnd = new Date(now + WINDOW_FUTURE_DAYS * 864e5);
    const parsed = parseIcsToRows(result.body, winStart, winEnd);

    // Dedupe op uid (instances hebben al een uniek suffix; masters kunnen dubbel
    // voorkomen bij rare feeds) zodat de upsert-onConflict niet klaagt.
    const byUid = new Map<string, IcsEventRow>();
    for (const row of parsed) if (!byUid.has(row.uid)) byUid.set(row.uid, row);
    const rows = [...byUid.values()];

    const nowIso = new Date().toISOString();
    // change_seq is een DB-monotone teller die per event-mutatie ophoogt (trigger
    // bump_calendar_event_sync zet event.sync_rev = die teller). We onthouden de
    // stand vóór deze sync: elke rij die we hierna upserten krijgt een sync_rev
    // boven deze grens; verdwenen rijen blijven eronder en verwijderen we daarna.
    // Zo hebben we geen (klok-gevoelige) tijdstempel of enorme uid-lijst nodig.
    const { data: srcRow } = await supabaseAdmin.from('calendar_sources').select('change_seq').eq('id', source.id).single();
    const baseSeq = Number((srcRow as { change_seq?: number } | null)?.change_seq ?? 0);
    if (rows.length) {
      const payload = rows.map(r => ({
        organization_id: source.organization_id,
        source_id: source.id,
        uid: r.uid,
        title: r.title,
        description: r.description,
        location: r.location,
        starts_at: r.starts_at,
        ends_at: r.ends_at,
        all_day: r.all_day,
        recurs: false,
        deleted_at: null,
      }));
      // In batches upserten (grote feeds kunnen duizenden rijen hebben).
      for (let i = 0; i < payload.length; i += 500) {
        const { error } = await supabaseAdmin.from('calendar_events')
          .upsert(payload.slice(i, i + 500), { onConflict: 'source_id,uid' });
        if (error) throw error;
      }
    }
    // Verdwenen items hard verwijderen (read-only cache): alles wat deze sync niet
    // heeft aangeraakt (sync_rev <= de stand van vóór de sync). Bij een lege feed
    // valt alles hieronder → volledige opschoning.
    const { error: delError } = await supabaseAdmin.from('calendar_events')
      .delete().eq('source_id', source.id).lte('sync_rev', baseSeq);
    if (delError) throw delError;

    await supabaseAdmin.from('calendar_sources').update({
      feed_etag: result.etag,
      feed_content_hash: hash,
      feed_last_synced_at: nowIso,
      feed_last_error: null,
    }).eq('id', source.id);

    return { changed: true, count: rows.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ophalen mislukt.';
    await supabaseAdmin.from('calendar_sources')
      .update({ feed_last_synced_at: new Date().toISOString(), feed_last_error: message.slice(0, 500) }).eq('id', source.id);
    throw err;
  }
}

/** Cron: ververs alle ICS-bronnen die langer dan `maxAgeMinutes` niet gesynct zijn. */
export async function syncDueIcsSubscriptions(maxAgeMinutes: number): Promise<{ processed: number; changed: number; failed: number }> {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString();
  const { data, error } = await supabaseAdmin.from('calendar_sources').select('*')
    .eq('provider', 'ics').eq('sync_enabled', true)
    .or(`feed_last_synced_at.is.null,feed_last_synced_at.lt.${cutoff}`)
    .limit(200);
  if (error) throw error;
  const sources = (data ?? []) as CalendarSourceRow[];
  let changed = 0, failed = 0;
  for (const source of sources) {
    try { const r = await syncIcsSource(source); if (r.changed) changed++; }
    catch (err) { failed++; console.warn('ICS sync failed for source', source.id, err instanceof Error ? err.message : err); }
  }
  return { processed: sources.length, changed, failed };
}
