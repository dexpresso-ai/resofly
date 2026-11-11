// Boekingslinks in de app: woorden, tijden en weken voor het beheer
// (MeetingBookingManager), de klantpagina in het CRM (ClientBookingLinks) en
// de publieke boekingspagina die de klant zelf ziet (PublicBookingPage).
//
// Waarom een eigen bestand: de drie schermen zeiden elk iets anders. Het beheer
// toonde de status van een boeking in het Engels ("confirmed"), de publieke
// pagina rekende de week uit in de tijdzone van de browser (een klant in
// Londen zag zondagavond 23.30 uur in de verkeerde week, terwijl de database
// de weeklimiet in Nederlandse tijd telt), en "verlopen" betekende in het
// scherm iets anders dan op de server. Puur, zonder React:
// bookingLinks.test.ts legt het vast.

import type { MeetingBookingLinkState, MeetingBookingSlotStatus, MeetingBookingStatus } from '../types';

export const BOOKING_TIME_ZONE = 'Europe/Amsterdam';

export type BookingTone = 'success' | 'info' | 'muted' | 'warning' | 'danger';

/** De stand van een link in één woord, met een kleur. */
export const LINK_STATE_LABELS: Record<MeetingBookingLinkState, { label: string; tone: BookingTone }> = {
  open: { label: 'Open', tone: 'success' },
  full: { label: 'Volgeboekt', tone: 'info' },
  closed: { label: 'Gesloten', tone: 'muted' },
  expired: { label: 'Verlopen', tone: 'warning' },
  unavailable: { label: 'Niet beschikbaar', tone: 'danger' },
};

export const BOOKING_STATUS_LABELS: Record<MeetingBookingStatus, string> = {
  pending: 'Wordt verwerkt',
  confirmed: 'Bevestigd',
  cancelled: 'Geannuleerd',
  failed: 'Mislukt',
};

export const SLOT_STATUS_LABELS: Record<MeetingBookingSlotStatus, { label: string; tone: BookingTone }> = {
  open: { label: 'Vrij', tone: 'success' },
  pending: { label: 'Wordt geboekt', tone: 'warning' },
  booked: { label: 'Geboekt', tone: 'info' },
  cancelled: { label: 'Vervallen', tone: 'muted' },
};

/**
 * Wat de stand betekent voor wie de link beheert, in één zin, met wat hij
 * eraan kan doen.
 */
export function linkStateExplanation(state: MeetingBookingLinkState, openSlots: number): string {
  switch (state) {
    case 'open':
      return openSlots === 0
        ? 'De link werkt, maar er staan geen vrije momenten op: de klant ziet een lege pagina. Voeg momenten toe.'
        : `De klant kan kiezen uit ${openSlots} ${openSlots === 1 ? 'vrij moment' : 'vrije momenten'}.`;
    case 'full': return 'Alle afspraken die via deze link kunnen, zijn gemaakt. Verhoog het maximum als de klant nog een moment mag kiezen.';
    case 'closed': return 'Gesloten: de klant kan niets meer boeken. Gemaakte afspraken blijven staan.';
    case 'expired': return 'Verlopen: de link in de mail van de klant werkt niet meer. Verleng hem, dan werkt dezelfde link weer.';
    case 'unavailable': return 'Wie deze link maakte, mag niet meer in de Agenda schrijven of is geen teamlid meer. Daarom boekt de link niets. Maak een nieuwe link.';
  }
}

/** De datum in Nederlandse tijd als JJJJ-MM-DD. */
export function amsterdamDateKey(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: BOOKING_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/**
 * De maandag van de week waarin `iso` valt, in Nederlandse tijd (JJJJ-MM-DD).
 * Dezelfde week als de weeklimiet in de database:
 * date_trunc('week', starts_at at time zone 'Europe/Amsterdam').
 */
export function amsterdamWeekKey(iso: string): string {
  const day = new Date(`${amsterdamDateKey(iso)}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

/** Momenten per dag (Nederlandse tijd), op volgorde. */
export function groupByDay<T extends { starts_at: string }>(slots: T[]): Array<{ day: string; slots: T[] }> {
  const groups = new Map<string, T[]>();
  for (const slot of [...slots].sort((a, b) => a.starts_at.localeCompare(b.starts_at))) {
    const key = amsterdamDateKey(slot.starts_at);
    const list = groups.get(key);
    if (list) list.push(slot); else groups.set(key, [slot]);
  }
  return [...groups.entries()].map(([day, list]) => ({ day, slots: list }));
}

/** "30 min", "1 uur", "1 u 30 min". */
export function durationLabel(startsAt: string, endsAt: string): string {
  const minutes = Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60000);
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} u ${rest} min` : `${hours} uur`;
}

/** Eén duur als alle momenten even lang zijn, anders null. */
export function commonDuration(slots: Array<{ starts_at: string; ends_at: string }>): string | null {
  const labels = new Set(slots.map(s => durationLabel(s.starts_at, s.ends_at)).filter(Boolean));
  return labels.size === 1 ? [...labels][0] : null;
}

const fmt = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('nl-NL', { timeZone: BOOKING_TIME_ZONE, ...options });

/** "maandag 16 november". */
export function fmtDayLong(iso: string): string { return fmt({ weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso)); }
/** "ma 16 nov". */
export function fmtDayShort(iso: string): string { return fmt({ weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso)); }
/** "10:00". */
export function fmtTime(iso: string): string { return fmt({ hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); }
/** "16 nov 2026". */
export function fmtDate(iso: string): string { return fmt({ day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso)); }
/** "ma 16 nov · 10:00–10:30". */
export function fmtMoment(startsAt: string, endsAt: string): string { return `${fmtDayShort(startsAt)} · ${fmtTime(startsAt)}–${fmtTime(endsAt)}`; }
/** Een dag-sleutel (JJJJ-MM-DD) als "maandag 16 november". */
export function fmtDayKey(day: string): string { return fmtDayLong(`${day}T12:00:00Z`); }

/** "Week van 16 – 22 nov" voor een maandag-sleutel. */
export function fmtWeekLabel(mondayKey: string): string {
  const start = new Date(`${mondayKey}T12:00:00Z`);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const f = fmt({ day: 'numeric', month: 'short' });
  return `Week van ${f.format(start)} – ${f.format(end)}`;
}

/**
 * Hoe lang de link nog werkt. "Binnenkort" is binnen veertien dagen: dan is er
 * nog tijd om hem te verlengen voordat de klant tegen een dichte deur loopt.
 */
export function expiryLabel(expiresAt: string | null | undefined, now: number = Date.now()): { text: string; tone: 'ok' | 'soon' | 'expired' | 'none' } {
  if (!expiresAt) return { text: 'Nog geen link', tone: 'none' };
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return { text: 'Nog geen link', tone: 'none' };
  if (at <= now) return { text: `Verlopen op ${fmtDate(expiresAt)}`, tone: 'expired' };
  const days = Math.ceil((at - now) / 86_400_000);
  if (days <= 14) return { text: days <= 1 ? `Verloopt binnen een dag (${fmtDate(expiresAt)})` : `Verloopt over ${days} dagen (${fmtDate(expiresAt)})`, tone: 'soon' };
  return { text: `Geldig tot ${fmtDate(expiresAt)}`, tone: 'ok' };
}

/** "Je kiest één moment" / "Je kiest maximaal 3 momenten, hooguit 1 per week". */
export function choiceRule(maxTotal: number, maxPerWeek: number, alreadyBooked = 0): string {
  const left = Math.max(0, maxTotal - alreadyBooked);
  const base = left <= 1 ? 'Je kiest één moment' : `Je kiest maximaal ${left} momenten`;
  return left > 1 && maxPerWeek < left ? `${base}, hooguit ${maxPerWeek} per week` : base;
}

// ── Videogesprek: welke dienst ──────────────────────────────────────────────

/** Dezelfde sleutels als BookingVideoKind in _shared/meetingBookingRules.ts. */
export type BookingVideoKind = 'jitsi' | 'google_meet' | 'teams' | 'zoom' | 'link';

/**
 * Wat de klant over het videogesprek moet weten: de naam van de dienst en hoe
 * hij meedoet. Eerst stond er op de boekingspagina alleen "Jitsi Meet" in een
 * tegel, en bij een vaste link "Link volgt per mail"; of het Teams of Meet was
 * (en of je daar een app voor nodig had), zag je pas als de mail er was.
 */
export const VIDEO_INFO: Record<BookingVideoKind, { name: string; how: string }> = {
  jitsi: { name: 'Jitsi Meet', how: 'Je doet mee via je browser. Je hebt geen account of app nodig.' },
  google_meet: { name: 'Google Meet', how: 'Je doet mee via je browser of de Google Meet-app.' },
  teams: { name: 'Microsoft Teams', how: 'Je doet mee via je browser of de Teams-app.' },
  zoom: { name: 'Zoom', how: 'Je doet mee via de Zoom-app of je browser.' },
  link: { name: 'Videogesprek', how: 'De link naar het gesprek krijg je in je bevestiging.' },
};

const VIDEO_KINDS = Object.keys(VIDEO_INFO) as BookingVideoKind[];

export function isBookingVideoKind(value: unknown): value is BookingVideoKind {
  return typeof value === 'string' && (VIDEO_KINDS as string[]).includes(value);
}

/**
 * De dienst van een boekingslink: de sleutel van de server (`video_service`),
 * of, bij een server van vóór 11 november, afgeleid uit de zin (`video`).
 */
export function videoKindOf(link: { video_service?: unknown; video?: unknown } | null | undefined): BookingVideoKind | null {
  if (!link) return null;
  if (isBookingVideoKind(link.video_service)) return link.video_service;
  if (link.video_service === null && 'video_service' in link) return null;
  const label = typeof link.video === 'string' ? link.video : '';
  if (!label) return null;
  if (/jitsi/i.test(label)) return 'jitsi';
  if (/google meet/i.test(label)) return 'google_meet';
  if (/teams/i.test(label)) return 'teams';
  if (/zoom/i.test(label)) return 'zoom';
  return 'link';
}

// ── Momenten maken: opdelen en een weekpatroon ──────────────────────────────

export type SlotTimes = { startsAt: string; endsAt: string };

/** Zoveel momenten maakt het beheer hooguit in één keer (de server neemt er 200 per aanvraag). */
export const MAX_GENERATED_SLOTS = 500;

/**
 * Een getekend blok als momenten van `durationMin` minuten, met `bufferMin`
 * pauze ertussen. 0 = het blok zoals getekend.
 *
 * Waarom: eerst was elk getekend blok één moment. Wie de klant een ochtend
 * wilde aanbieden in halve uren, sleepte zes keer, en een sleep van 9.00 tot
 * 12.00 uur gaf de klant één afspraak van drie uur. Een klik (zonder slepen)
 * geeft nu één moment van de gekozen duur.
 */
export function splitIntoSlots(startsAt: string, endsAt: string, durationMin: number, bufferMin = 0): SlotTimes[] {
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const iso = (ms: number) => new Date(ms).toISOString();
  if (!Number.isFinite(durationMin) || durationMin <= 0) return [{ startsAt: iso(start), endsAt: iso(end) }];
  const len = Math.round(durationMin) * 60_000;
  const step = len + Math.max(0, Math.round(bufferMin || 0)) * 60_000;
  const out: SlotTimes[] = [];
  for (let t = start; t + len <= end && out.length < MAX_GENERATED_SLOTS; t += step) out.push({ startsAt: iso(t), endsAt: iso(t + len) });
  return out.length ? out : [{ startsAt: iso(start), endsAt: iso(start + len) }];
}

/** Een weekpatroon: op welke dagen, van hoe laat tot hoe laat, en hoeveel weken. */
export interface SlotPattern {
  /** 1 = maandag … 7 = zondag. */
  weekdays: number[];
  /** "09:00". */
  from: string;
  /** "12:00". */
  to: string;
  durationMin: number;
  bufferMin: number;
  /** 1 tot en met 12. */
  weeks: number;
  /** De eerste dag (JJJJ-MM-DD), in de tijd van je eigen apparaat. */
  startDate: string;
}

function parseClock(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 24 && min < 60 && h * 60 + min <= 24 * 60 ? h * 60 + min : null;
}

/**
 * Alle momenten van een weekpatroon, in de tijd van je eigen apparaat (zoals
 * het rooster). Momenten die al begonnen zijn, vallen weg; hooguit 500.
 */
export function generatePatternSlots(pattern: SlotPattern, now: number = Date.now()): SlotTimes[] {
  const from = parseClock(pattern.from);
  const to = parseClock(pattern.to);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(pattern.startDate);
  if (from === null || to === null || to <= from || !m || !pattern.weekdays.length) return [];
  const weeks = Math.min(12, Math.max(1, Math.round(pattern.weeks) || 1));
  const days = new Set(pattern.weekdays);
  const out: SlotTimes[] = [];
  for (let i = 0; i < weeks * 7 && out.length < MAX_GENERATED_SLOTS; i++) {
    const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + i);
    const weekday = ((day.getDay() + 6) % 7) + 1;
    if (!days.has(weekday)) continue;
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, from);
    const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, to);
    for (const slot of splitIntoSlots(start.toISOString(), end.toISOString(), pattern.durationMin, pattern.bufferMin)) {
      if (Date.parse(slot.startsAt) <= now) continue;
      // Een patroon past precies in het blok, of het moment valt weg.
      if (Date.parse(slot.endsAt) > end.getTime()) continue;
      out.push(slot);
      if (out.length >= MAX_GENERATED_SLOTS) break;
    }
  }
  return out;
}

/** "ma t/m vr", "ma, wo, vr", "elke dag". */
export function weekdaysLabel(weekdays: number[]): string {
  const names = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'];
  const sorted = [...new Set(weekdays)].filter(d => d >= 1 && d <= 7).sort((a, b) => a - b);
  if (sorted.length === 7) return 'elke dag';
  if (sorted.length >= 3 && sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1)) return `${names[sorted[0] - 1]} t/m ${names[sorted[sorted.length - 1] - 1]}`;
  return sorted.map(d => names[d - 1]).join(', ');
}

// ── De kalender op de boekingspagina ────────────────────────────────────────

/** "2026-11" voor een dag-sleutel. */
export function monthKeyOf(dayKey: string): string { return dayKey.slice(0, 7); }

/** De maand ervoor of erna ("2026-11" → "2026-12"). */
export function shiftMonth(monthKey: string, delta: number): string {
  const [y, mo] = monthKey.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + delta, 1, 12));
  return d.toISOString().slice(0, 7);
}

/** "november 2026". */
export function fmtMonthLabel(monthKey: string): string {
  return fmt({ month: 'long', year: 'numeric' }).format(new Date(`${monthKey}-15T12:00:00Z`));
}

/**
 * De weken van een maand voor een kalender: zeven dag-sleutels per rij, van
 * maandag tot zondag. Dagen van de maand ervoor en erna zijn null.
 */
export function monthGrid(monthKey: string): Array<Array<string | null>> {
  const [y, mo] = monthKey.split('-').map(Number);
  const first = new Date(Date.UTC(y, mo - 1, 1, 12));
  const daysInMonth = new Date(Date.UTC(y, mo, 0, 12)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;
  const cells: Array<string | null> = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(`${monthKey}-${String(d).padStart(2, '0')}`);
  while (cells.length % 7) cells.push(null);
  const rows: Array<Array<string | null>> = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}

/** "17" en "di" voor een dag-sleutel (Nederlandse tijd). */
export function fmtDayParts(dayKey: string): { weekday: string; day: string; month: string } {
  const d = new Date(`${dayKey}T12:00:00Z`);
  return {
    weekday: fmt({ weekday: 'short' }).format(d).replace('.', ''),
    day: String(Number(dayKey.slice(8, 10))),
    month: fmt({ month: 'short' }).format(d).replace('.', ''),
  };
}

// ── Een afspraak in je eigen agenda (.ics) ──────────────────────────────────

/** Tekst in een iCalendar-veld: backslash, puntkomma, komma en regeleinde ontsnapt; stuurtekens weg. */
export function icsText(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

function icsStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Lange regels vouwen (RFC 5545: hooguit 75 tekens, vervolg met een spatie). */
function icsFold(line: string): string {
  if (line.length <= 73) return line;
  const parts: string[] = [];
  for (let i = 0; i < line.length; i += 73) parts.push(line.slice(i, i + 73));
  return parts.join('\r\n ');
}

/** Alleen een http(s)-link zonder spaties of stuurtekens. */
export function safeMeetingLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  // eslint-disable-next-line no-control-regex
  if (!raw || raw.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Een agenda-bestand met één afspraak, voor "Zet in je agenda". Alles wat erin
 * staat komt van de leverancier of de server; daarom wordt elk veld ontsnapt
 * (een regeleinde in een titel maakte er anders een eigen regel van, met
 * bijvoorbeeld een andere begintijd) en komt alleen een echte http(s)-link mee.
 */
export function buildIcs(ev: { uid: string; title: string; startsAt: string; endsAt: string; description?: string | null; url?: string | null }, now: number = Date.now()): string {
  const start = Date.parse(ev.startsAt);
  const end = Date.parse(ev.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return '';
  const url = safeMeetingLink(ev.url);
  const description = [ev.description?.trim(), url ? `Videogesprek: ${url}` : ''].filter(Boolean).join('\n\n');
  const uid = `${ev.uid.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80) || 'afspraak'}@resofly`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ResoFly//Afspraak//NL',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsStamp(now)}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:${icsText(ev.title.slice(0, 200))}`,
    ...(description ? [`DESCRIPTION:${icsText(description.slice(0, 2000))}`] : []),
    ...(url ? [`LOCATION:${icsText(url)}`, `URL:${url}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(icsFold).join('\r\n')}\r\n`;
}

/**
 * De dienst van een boekingslink in het beheer, met dezelfde volgorde als de
 * server (bookingVideoService in _shared/meetingBookingRules.ts): een vaste
 * link gaat voor, anders wat de link per boeking maakt.
 */
export function linkVideoKind(link: { meeting_url?: string | null; auto_conference?: boolean | null; conference_provider?: string | null }, sourceProvider: string | null | undefined): BookingVideoKind | null {
  const url = safeMeetingLink(link.meeting_url);
  if (url) {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'meet.google.com') return 'google_meet';
    if (host === 'teams.microsoft.com' || host === 'teams.live.com' || host.endsWith('.teams.microsoft.com')) return 'teams';
    if (host === 'zoom.us' || host === 'zoom.com' || host.endsWith('.zoom.us') || host.endsWith('.zoom.com')) return 'zoom';
    if (host === 'meet.jit.si' || host === '8x8.vc' || /\/ResoFly-[A-Za-z0-9]{14}\/?$/.test(new URL(url).pathname)) return 'jitsi';
    return 'link';
  }
  if (link.auto_conference === false) return null;
  const provider = link.conference_provider ?? 'calendar';
  if (provider === 'jitsi' || provider === 'google_meet' || provider === 'teams') return provider;
  return sourceProvider === 'google' ? 'google_meet' : sourceProvider === 'microsoft' ? 'teams' : null;
}

// ── Je eigen afspraken in het rooster ─────────────────────────────────────
//
// Eerst toonde het rooster van een boekingslink alleen de afspraken uit de
// agenda van die link. Zette je de link in je ResoFly-agenda, dan zag je je
// Google- of Outlook-afspraken niet, en tekende je er zo een moment overheen:
// een dubbele boeking zodra de klant dat moment koos.

/**
 * De agenda's die in het rooster van een link meetellen: die van wie de link
 * maakte (de ResoFly-agenda, Google, Microsoft, een ICS-abonnement), met de
 * agenda van de link vooraan. Die van collega's niet: hun afspraken maken jou
 * niet bezet.
 */
export function bookingGridSources<T extends { id: string; user_id: string; sync_enabled: boolean }>(
  sources: readonly T[],
  ownerId: string | null | undefined,
  linkSourceId: string | null | undefined,
): T[] {
  const linkSource = sources.find(s => s.id === linkSourceId);
  const own = sources.filter(s => s.id !== linkSourceId && s.sync_enabled && Boolean(ownerId) && s.user_id === ownerId);
  return linkSource ? [linkSource, ...own] : own;
}

/**
 * De afspraak waar een moment mee botst, of null. Dezelfde regel als de server
 * (slotClash in meetingBookingRules.ts; de test legt vast dat ze gelijk
 * oplopen): alles in de agenda van de link telt, ook een hele dag, en in je
 * andere agenda's alleen een afspraak met een tijd. Een verjaardag of feestdag
 * maakt je niet bezet.
 */
export function clashingAppointment<T extends { source_id: string; starts_at: string; ends_at: string; all_day?: boolean }>(
  slot: SlotTimes,
  events: readonly T[],
  scope: { linkSourceId?: string | null; ownSourceIds: Iterable<string> },
): T | null {
  const starts = Date.parse(slot.startsAt);
  const ends = Date.parse(slot.endsAt);
  if (!Number.isFinite(starts) || !Number.isFinite(ends)) return null;
  const own = new Set(scope.ownSourceIds);
  for (const event of events) {
    const onLink = Boolean(scope.linkSourceId) && event.source_id === scope.linkSourceId;
    if (!onLink && (!own.has(event.source_id) || event.all_day === true)) continue;
    const evStarts = Date.parse(event.starts_at);
    const evEnds = Date.parse(event.ends_at);
    if (!Number.isFinite(evStarts) || !Number.isFinite(evEnds)) continue;
    if (evStarts < ends && evEnds > starts) return event;
  }
  return null;
}

/**
 * Wat er niet op de link kwam omdat je dan al een afspraak hebt, in één zin:
 * "2 momenten overgeslagen: dan heb je al een afspraak (Teamoverleg, Tandarts)."
 * Hooguit drie namen; een afgeschermde afspraak van een collega heet "Bezet".
 */
export function clashNotice(clashes: ReadonlyArray<{ conflict?: string | null }>): string {
  if (!clashes.length) return '';
  const names = [...new Set(clashes.map(c => (c.conflict ?? '').trim()).filter(Boolean))];
  const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ` en ${names.length - 3} meer` : '');
  const head = clashes.length === 1 ? '1 moment overgeslagen' : `${clashes.length} momenten overgeslagen`;
  return `${head}: dan heb je al een afspraak${shown ? ` (${shown})` : ''}.`;
}
