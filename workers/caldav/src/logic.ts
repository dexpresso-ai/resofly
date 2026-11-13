// De regels van de agendaserver die niets met netwerk of database te maken
// hebben: iCalendar lezen en schrijven, en wat een deellink wel en niet laat
// zien. Apart van index.ts, zodat `npm test` ze in Node kan toetsen.

/** Eén afspraak zoals hij in calendar_events staat (de kolommen die de server leest). */
export interface EventRow {
  id: string;
  source_id: string;
  uid: string;
  icalendar_raw: string | null;
  title: string;
  description: string | null;
  location: string | null;
  meeting_url?: string | null;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  rrule: string | null;
  exdate?: string[] | null;
  sequence: number;
  etag: string;
  sync_rev: number;
  deleted_at: string | null;
  updated_at: string;
}

/** Wat een deellink laat zien: alleen "Bezet", of ook titel en plaats. */
export type FeedDetail = 'busy' | 'details';

/** Wat de deellink van een afspraak nodig heeft. Bewust geen omschrijving, genodigden of vergaderlink. */
export type FeedEventRow = Pick<EventRow, 'uid' | 'title' | 'location' | 'starts_at' | 'ends_at' | 'all_day' | 'rrule' | 'exdate' | 'icalendar_raw' | 'sequence' | 'updated_at'>;

// Een deellink is 32 willekeurige bytes in base64url: 43 tekens. Dezelfde vorm
// maakt supabase/functions/_shared/calendarFeed.ts; logic.test.ts houdt ze gelijk.
export const FEED_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// Groter is geen afspraak meer. Zonder grens zette een client elke omvang in
// icalendar_raw, en die tekst gaat bij elke synchronisatie weer mee terug.
export const MAX_PUT_BYTES = 512 * 1024;

// Supabase geeft per verzoek hooguit 1000 rijen (max_rows). Wie meer vroeg,
// kreeg er stil 1000: een agenda met meer afspraken miste de rest op de telefoon.
export const PAGE_SIZE = 1000;

/* ── iCalendar lezen ─────────────────────────────────────────────────── */

export interface IcsProp { name: string; params: Record<string, string>; value: string; raw: string }
export interface IcsComponent { name: string; props: IcsProp[]; children: IcsComponent[]; lines: string[] }

export function unfoldIcs(text: string): string[] {
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

/**
 * Eén regel als naam, parameters en waarde. Een dubbele punt of puntkomma
 * tussen aanhalingstekens hoort bij een parameter (`ALTREP="https://…"`); de
 * oude parser knipte daar de regel door en las de rest als waarde.
 */
export function parsePropLine(line: string): IcsProp | null {
  let inQuote = false;
  let colon = -1;
  const cuts: number[] = [];
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && ch === ';') cuts.push(i);
    else if (!inQuote && ch === ':') { colon = i; break; }
  }
  if (colon < 0) return null;
  const left = line.slice(0, colon);
  const segs: string[] = [];
  let start = 0;
  for (const cut of cuts) { segs.push(left.slice(start, cut)); start = cut + 1; }
  segs.push(left.slice(start));
  const name = segs[0].trim().toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(name)) return null;
  const params: Record<string, string> = {};
  for (let i = 1; i < segs.length; i++) {
    const eq = segs[i].indexOf('=');
    if (eq > 0) params[segs[i].slice(0, eq).trim().toUpperCase()] = segs[i].slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value: line.slice(colon + 1), raw: line };
}

/**
 * De componenten van een iCalendar-tekst, met hun eigen regels. Een herinnering
 * (VALARM) is een eigen component binnen de afspraak: de oude parser las haar
 * regels als die van de afspraak, en dan werd de tekst van de herinnering
 * ("Herinnering") de omschrijving van een afspraak zonder omschrijving.
 */
export function parseComponents(text: string): IcsComponent[] {
  const roots: IcsComponent[] = [];
  const stack: IcsComponent[] = [];
  for (const line of unfoldIcs(text)) {
    if (!line.trim()) continue;
    const begin = /^BEGIN:([A-Za-z0-9-]+)\s*$/i.exec(line);
    if (begin) {
      const comp: IcsComponent = { name: begin[1].toUpperCase(), props: [], children: [], lines: [] };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(comp); else roots.push(comp);
      stack.push(comp);
      for (const open of stack) open.lines.push(line);
      continue;
    }
    const end = /^END:([A-Za-z0-9-]+)\s*$/i.exec(line);
    if (end) {
      const name = end[1].toUpperCase();
      const at = stack.map(c => c.name).lastIndexOf(name);
      if (at < 0) continue;
      for (const open of stack) open.lines.push(line);
      stack.length = at;
      continue;
    }
    const top = stack[stack.length - 1];
    if (!top) continue;
    for (const open of stack) open.lines.push(line);
    const prop = parsePropLine(line);
    if (prop) top.props.push(prop);
  }
  return roots;
}

/** Alle componenten met deze naam, op elke diepte. */
export function findComponents(roots: IcsComponent[], name: string): IcsComponent[] {
  const out: IcsComponent[] = [];
  const walk = (list: IcsComponent[]) => {
    for (const c of list) {
      if (c.name === name) out.push(c);
      walk(c.children);
    }
  };
  walk(roots);
  return out;
}

function prop(comp: IcsComponent, name: string): IcsProp | undefined {
  return comp.props.find(p => p.name === name);
}

export interface ParsedEvent {
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

/** De velden die de app toont, uit de tekst die een telefoon stuurt. */
export function parseICalEvent(text: string): ParsedEvent {
  const events = findComponents(parseComponents(text), 'VEVENT');
  if (!events.length) throw new Error('geen VEVENT gevonden');
  // De hoofdafspraak is die zonder RECURRENCE-ID; de rest zijn verplaatste keren.
  const master = events.find(e => !prop(e, 'RECURRENCE-ID')) ?? events[0];
  const get = (n: string) => prop(master, n);

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
  for (const p of master.props) {
    if (p.name !== 'EXDATE') continue;
    for (const part of p.value.split(',')) {
      if (!part.trim()) continue;
      exdateValues.push(parseIcsTime({ name: 'EXDATE', params: p.params, value: part, raw: '' }).iso);
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

export function parseIcsTime(p: IcsProp | undefined): { iso: string; allDay: boolean; tzid: string | null } {
  if (!p || !p.value) return { iso: new Date().toISOString(), allDay: false, tzid: null };
  const value = p.value.trim();
  // Hele dag: VALUE=DATE of een kale YYYYMMDD.
  if (p.params.VALUE === 'DATE' || /^\d{8}$/.test(value)) {
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
  const tzid = p.params.TZID || null;
  if (tzid) {
    return { iso: wallTimeToUtcIso(+y, +mo, +d, +h, +mi, +s, tzid), allDay: false, tzid };
  }
  // Zwevende tijd (geen zone): als UTC, bij gebrek aan beter.
  return { iso: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)).toISOString(), allDay: false, tzid: null };
}

// Wandkloktijd in een IANA-zone → UTC-ISO, via Intl (rekent zomertijd mee).
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
  for (const part of parts) if (part.type !== 'literal') map[part.type] = parseInt(part.value, 10);
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

export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/* ── iCalendar schrijven ─────────────────────────────────────────────── */

export function icsUtc(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}

export function icsDate(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}`;
}

function addUtcDays(date: Date, days: number): Date {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export function escapeIcsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

function utf8Length(codePoint: number): number {
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}

/**
 * Een regel van meer dan 75 bytes vouwen (RFC 5545 §3.1), zonder een teken
 * door te knippen. Eerst telde dit tekens in plaats van bytes: een titel met
 * accenten of een emoji gaf regels die langer waren dan mag.
 */
export function foldIcsLine(line: string): string {
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = utf8Length(ch.codePointAt(0) ?? 0);
    if (bytes + n > limit) {
      parts.push(current);
      current = '';
      bytes = 0;
      limit = 74; // de spatie vooraan telt mee
    }
    current += ch;
    bytes += n;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

function validDate(value: string): Date | null {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Begin, eind, herhaling en weggelaten keren, uit de velden van de app. */
function timeLines(ev: Pick<EventRow, 'starts_at' | 'ends_at' | 'all_day' | 'rrule' | 'exdate'>): string[] {
  const lines: string[] = [];
  const start = new Date(ev.starts_at);
  if (ev.all_day) {
    let endExclusive = new Date(ev.ends_at);
    if (endExclusive.getTime() <= start.getTime()) endExclusive = addUtcDays(start, 1);
    lines.push(`DTSTART;VALUE=DATE:${icsDate(start)}`);
    lines.push(`DTEND;VALUE=DATE:${icsDate(endExclusive)}`);
  } else {
    lines.push(`DTSTART:${icsUtc(start)}`);
    lines.push(`DTEND:${icsUtc(new Date(ev.ends_at))}`);
  }
  const rrule = (ev.rrule ?? '').replace(/[\r\n]/g, '').trim();
  if (rrule) {
    lines.push(`RRULE:${rrule}`);
    // Een keer die op de telefoon uit de reeks is gehaald. Zonder deze regel
    // kwam hij terug zodra iemand de afspraak in ResoFly bewerkte: de app gooit
    // dan de tekst van de telefoon weg en deze server maakt een nieuwe.
    const dates = (ev.exdate ?? []).map(validDate).filter((d): d is Date => d !== null);
    if (dates.length) {
      lines.push(ev.all_day
        ? `EXDATE;VALUE=DATE:${dates.map(icsDate).join(',')}`
        : `EXDATE:${dates.map(icsUtc).join(',')}`);
    }
  }
  return lines;
}

/** Het tijdstempel van een afspraak: de laatste wijziging, zodat dezelfde afspraak dezelfde tekst geeft. */
function stamp(ev: Pick<EventRow, 'updated_at'>, fallback: Date): string {
  return icsUtc(validDate(ev.updated_at) ?? fallback);
}

/** De afspraak voor de eigen telefoon of computer (CalDAV): alles wat de app ook toont. */
export function icsForEvent(ev: EventRow, now = new Date()): string {
  if (ev.icalendar_raw && ev.icalendar_raw.trim()) return ev.icalendar_raw;
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ResoFly//CalDAV//NL',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(ev.uid)}`,
    `DTSTAMP:${stamp(ev, now)}`,
    ...timeLines(ev),
    `SUMMARY:${escapeIcsText(ev.title || '(Geen titel)')}`,
  ];
  if (ev.description) lines.push(`DESCRIPTION:${escapeIcsText(ev.description)}`);
  if (ev.location) lines.push(`LOCATION:${escapeIcsText(ev.location)}`);
  const meetingUrl = safeUrl(ev.meeting_url);
  if (meetingUrl) lines.push(`URL:${meetingUrl}`);
  lines.push(`SEQUENCE:${Number.isFinite(ev.sequence) ? ev.sequence : 0}`);
  lines.push(`LAST-MODIFIED:${stamp(ev, now)}`);
  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^https?:\/\/[^\s"<>\\]+$/i.test(trimmed) ? trimmed : null;
}

/* ── De deellink ─────────────────────────────────────────────────────── */

// Uit de tekst van de telefoon gaan alleen de tijden mee, en bij "details" de
// titel en de plaats. Geen omschrijving, genodigden, organisator, bijlagen,
// herinneringen of links: wie de link krijgt, hoort niet meer te zien dan wat de
// eigenaar koos, ook niet wat er toevallig in een veld van de telefoon staat.
const FEED_KEEP = new Set([
  'UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'DURATION', 'RRULE', 'RDATE', 'EXDATE', 'RECURRENCE-ID',
  'SEQUENCE', 'STATUS', 'TRANSP', 'CREATED', 'LAST-MODIFIED',
]);

const BUSY = 'Bezet';

/**
 * De agenda als één .ics voor wie de deellink heeft (Google Agenda, Outlook,
 * Apple Agenda). Een afspraak die op de telefoon als privé is gemarkeerd, is
 * ook bij "details" alleen "Bezet".
 */
export function buildFeed(calendarName: string, events: FeedEventRow[], detail: FeedDetail, now = new Date()): string {
  const name = escapeIcsText(calendarName.trim() || 'Agenda');
  const head = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ResoFly//Agenda-deellink//NL',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `NAME:${name}`,
    `X-WR-CALNAME:${name}`,
    // Hoe vaak een agenda-app opnieuw kijkt. Google en Outlook doen het op hun eigen tempo.
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  const timezones = new Map<string, string[]>();
  const vevents: string[][] = [];
  for (const ev of events) {
    const fromPhone = ev.icalendar_raw && ev.icalendar_raw.trim() ? feedEventsFromRaw(ev, detail, timezones, now) : [];
    if (fromPhone.length) vevents.push(...fromPhone);
    else vevents.push(feedEventFromFields(ev, detail, now));
  }
  const lines = [...head];
  for (const tz of timezones.values()) lines.push(...tz);
  for (const ev of vevents) lines.push(...ev);
  lines.push('END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

function feedEventFromFields(ev: FeedEventRow, detail: FeedDetail, now: Date): string[] {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(ev.uid)}`,
    `DTSTAMP:${stamp(ev, now)}`,
    ...timeLines(ev),
    `SUMMARY:${detail === 'details' ? escapeIcsText(ev.title || '(Geen titel)') : BUSY}`,
  ];
  if (detail === 'details' && ev.location) lines.push(`LOCATION:${escapeIcsText(ev.location)}`);
  lines.push(`SEQUENCE:${Number.isFinite(ev.sequence) ? ev.sequence : 0}`);
  lines.push('END:VEVENT');
  return lines;
}

/**
 * Een afspraak van de telefoon: de tijden zoals de telefoon ze schreef, met
 * tijdzone, zodat "elke maandag 9.00 uur" ook na de zomertijd om 9.00 uur staat.
 * Verplaatste keren (RECURRENCE-ID) gaan mee als eigen afspraak.
 */
function feedEventsFromRaw(ev: FeedEventRow, detail: FeedDetail, timezones: Map<string, string[]>, now: Date): string[][] {
  const roots = parseComponents(ev.icalendar_raw ?? '');
  for (const tz of findComponents(roots, 'VTIMEZONE')) {
    const tzid = prop(tz, 'TZID')?.value.trim();
    if (tzid && !timezones.has(tzid)) timezones.set(tzid, tz.lines);
  }
  return findComponents(roots, 'VEVENT').map(vevent => {
    const isPrivate = /^(PRIVATE|CONFIDENTIAL)$/i.test(prop(vevent, 'CLASS')?.value.trim() ?? '');
    const showDetails = detail === 'details' && !isPrivate;
    const lines = ['BEGIN:VEVENT'];
    for (const p of vevent.props) if (FEED_KEEP.has(p.name)) lines.push(p.raw);
    if (!prop(vevent, 'UID')) lines.splice(1, 0, `UID:${escapeIcsText(ev.uid)}`);
    if (!prop(vevent, 'DTSTAMP')) lines.push(`DTSTAMP:${stamp(ev, now)}`);
    const summary = prop(vevent, 'SUMMARY')?.value.trim();
    lines.push(`SUMMARY:${showDetails ? (summary || escapeIcsText('(Geen titel)')) : BUSY}`);
    const location = prop(vevent, 'LOCATION')?.value.trim();
    if (showDetails && location) lines.push(`LOCATION:${location}`);
    lines.push('END:VEVENT');
    return lines;
  });
}

/** Het token uit /feed/<token>.ics, of null als het pad geen deellink is. */
export function feedTokenFromPath(segments: string[]): string | null {
  if (segments.length !== 2 || segments[0] !== 'feed') return null;
  const token = segments[1].replace(/\.ics$/i, '');
  return FEED_TOKEN_RE.test(token) ? token : null;
}

/* ── Overig ──────────────────────────────────────────────────────────── */

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Een lijst voor PostgREST `in.(…)`, elke waarde tussen aanhalingstekens. Een
 * UID mag komma's en haakjes bevatten; zonder aanhalingstekens las PostgREST
 * die als scheidingstekens.
 */
export function postgrestInList(values: string[]): string {
  return `(${values.map(v => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')})`;
}

export function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function unescapeXml(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** De UID's uit de adressen in een calendar-multiget. */
export function multigetUids(body: string): string[] {
  const hrefs = [...body.matchAll(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href>/gi)].map(m => unescapeXml(m[1].trim()));
  const uids = hrefs.map(h => {
    const last = h.split('/').pop() ?? '';
    try { return decodeURIComponent(last).replace(/\.ics$/i, ''); } catch { return ''; }
  });
  return [...new Set(uids.filter(Boolean))];
}
