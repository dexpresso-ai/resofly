// ============================================================
// Gedeelde agenda-kern (types, client, tokenbeheer, helpers)
//
// Deze module bevat de herbruikbare basis die zowel de bestaande
// `calendar-integrations`-functie als de nieuwe booking-functies en de
// Gerrie-agent nodig hebben: de service-role Supabase-client, OAuth-token-
// beheer voor Google/Microsoft, en de kleine parse-/format-helpers voor
// videocall-links, datums, genodigden-status en RRULE.
//
// Er worden BEWUST geen deno.land/std-imports toegevoegd (alleen esm.sh voor
// supabase-js): de bundler kreeg deno.land/std eerder intermitterend niet
// opgehaald, wat een BOOT_ERROR gaf. Functies die deze module importeren
// gebruiken de ingebouwde `Deno.serve` i.p.v. de std `serve`.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

export type Provider = 'google' | 'microsoft' | 'native';
export type CalendarVisibility = 'private' | 'organization';
export type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer';

export type CalendarSourceRow = {
  id: string;
  organization_id: string;
  user_id: string;
  connection_id: string | null;
  provider: Provider;
  provider_calendar_id: string;
  name: string;
  description: string | null;
  color: string | null;
  timezone: string | null;
  is_primary: boolean;
  access_role: string | null;
  sync_enabled: boolean;
  write_enabled: boolean;
  visibility: CalendarVisibility;
  created_at: string;
  updated_at: string;
};

export type ConnectionRow = {
  id: string;
  organization_id: string;
  user_id: string;
  provider: Provider;
  provider_account_id: string;
  provider_account_email: string | null;
  display_name: string | null;
  status: 'active' | 'expired' | 'revoked' | 'error';
  scopes: string[];
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type TokenRow = {
  connection_id: string;
  organization_id: string;
  user_id: string;
  provider: Provider;
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  token_type: string | null;
  scopes: string[];
  expires_at: string | null;
};

export type NativeEventRow = {
  id: string;
  organization_id: string;
  source_id: string;
  uid: string;
  title: string;
  description: string | null;
  location: string | null;
  meeting_url: string | null;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  timezone: string | null;
  rrule: string | null;
  exdate: string[] | null;
  recurs: boolean;
  sequence: number;
  organizer_token: string | null;
};

export type AttendeeRow = {
  id: string;
  organization_id: string;
  event_id: string;
  email: string;
  display_name: string | null;
  role: 'req' | 'opt';
  is_organizer: boolean;
  status: 'needs-action' | 'accepted' | 'declined' | 'tentative';
  invited_at: string | null;
  responded_at: string | null;
  last_sequence_sent: number;
};

export type SimpleRrule = { freq: 'DAILY' | 'WEEKLY' | 'MONTHLY'; interval: number; until: string | null; count: number | null };

export function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const SUPABASE_URL = requiredEnv('SUPABASE_URL');
export const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
export const TOKEN_ENCRYPTION_KEY = requiredEnv('CALENDAR_TOKEN_ENCRYPTION_KEY');

export const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CALENDAR_CLIENT_ID') || '';
export const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CALENDAR_CLIENT_SECRET') || '';
export const MICROSOFT_CLIENT_ID = Deno.env.get('MICROSOFT_CALENDAR_CLIENT_ID') || '';
export const MICROSOFT_CLIENT_SECRET = Deno.env.get('MICROSOFT_CALENDAR_CLIENT_SECRET') || '';
export const MICROSOFT_TENANT_ID = Deno.env.get('MICROSOFT_CALENDAR_TENANT_ID') || 'common';

// Uitnodigingen (iMIP) hergebruiken de bestaande mail-infrastructuur.
export const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
export const RESEND_FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || '';
export const MAIL_INBOUND_DOMAIN = Deno.env.get('MAIL_INBOUND_DOMAIN') || '';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── OAuth-scopes ────────────────────────────────────────────────────────────

export function googleScopes(): string[] {
  return [
    'openid', 'email', 'profile',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.events',
    // Contacten opzoeken bij het uitnodigen van genodigden.
    'https://www.googleapis.com/auth/contacts.readonly',
    'https://www.googleapis.com/auth/contacts.other.readonly',
  ];
}

export function microsoftScopes(): string[] {
  // People.Read = relevantie-gerangschikt adresboek (contacten + directory), Contacts.Read = opgeslagen contacten.
  return ['openid', 'profile', 'email', 'offline_access', 'User.Read', 'Calendars.ReadWrite', 'Contacts.Read', 'People.Read'];
}

export function parseScope(scope: unknown, fallback: string[]): string[] {
  if (typeof scope !== 'string' || !scope.trim()) return fallback;
  return scope.split(/\s+/).filter(Boolean);
}

// ── Verbindingen + tokens ───────────────────────────────────────────────────

export async function getConnection(organizationId: string, connectionId: string): Promise<ConnectionRow> {
  const { data, error } = await supabaseAdmin.from('calendar_connections').select('*').eq('organization_id', organizationId).eq('id', connectionId).single();
  if (error || !data) throw new Error('Agenda-koppeling niet gevonden.');
  return data as ConnectionRow;
}

export async function getToken(organizationId: string, connectionId: string): Promise<TokenRow> {
  const { data, error } = await supabaseAdmin.from('calendar_connection_tokens').select('*').eq('organization_id', organizationId).eq('connection_id', connectionId).single();
  if (error || !data) throw new Error('Agenda-token niet gevonden. Koppel het account opnieuw.');
  return data as TokenRow;
}

export async function refreshAccessToken(token: TokenRow): Promise<string> {
  const expires = token.expires_at ? new Date(token.expires_at).getTime() : 0;
  if (expires && expires - Date.now() > 120_000) return await decrypt(token.access_token_encrypted);
  if (!token.refresh_token_encrypted) return await decrypt(token.access_token_encrypted);

  const refreshToken = await decrypt(token.refresh_token_encrypted);
  const endpoint = token.provider === 'google'
    ? 'https://oauth2.googleapis.com/token'
    : `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: token.provider === 'google' ? GOOGLE_CLIENT_ID : MICROSOFT_CLIENT_ID,
    client_secret: token.provider === 'google' ? GOOGLE_CLIENT_SECRET : MICROSOFT_CLIENT_SECRET,
  });
  if (token.provider === 'microsoft') params.set('scope', microsoftScopes().join(' '));

  const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    await supabaseAdmin.from('calendar_connections').update({ status: 'expired', last_error: payload.error_description || payload.error || 'Refresh token verlopen' }).eq('id', token.connection_id);
    throw new Error(payload.error_description || payload.error || 'Agenda-token vernieuwen mislukt.');
  }

  const accessToken = String(payload.access_token || '');
  if (!accessToken) throw new Error('Provider gaf geen access token terug.');
  const nextRefreshToken = payload.refresh_token ? String(payload.refresh_token) : refreshToken;
  await supabaseAdmin.from('calendar_connection_tokens').update({
    access_token_encrypted: await encrypt(accessToken),
    refresh_token_encrypted: await encrypt(nextRefreshToken),
    token_type: payload.token_type ? String(payload.token_type) : token.token_type,
    scopes: parseScope(payload.scope, token.scopes),
    expires_at: payload.expires_in ? new Date(Date.now() + Number(payload.expires_in) * 1000).toISOString() : token.expires_at,
  }).eq('connection_id', token.connection_id);
  await supabaseAdmin.from('calendar_connections').update({ status: 'active', last_error: null }).eq('id', token.connection_id);
  return accessToken;
}

/** Schrijfrecht-check op een externe agenda-bron (Google/Microsoft). */
export function sourceCanWrite(source: CalendarSourceRow): boolean {
  const role = String(source.access_role || '').toLowerCase();
  if (source.provider === 'google') return ['owner', 'writer'].includes(role);
  if (source.provider === 'microsoft') return role === 'writer' || role === 'owner';
  return false;
}

export function assertIso(value: string, field: string): string {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new Error(`Ongeldige datum voor ${field}.`);
  return date.toISOString();
}

// ── Videovergadering-link (Google Meet / Teams / Zoom / overig) ──────────────

/** Vertaalt de RSVP-status van Google/Microsoft naar onze eigen statussen. */
export function mapAttendeeStatus(raw: unknown): 'needs-action' | 'accepted' | 'declined' | 'tentative' {
  switch (String(raw || '').toLowerCase()) {
    case 'accepted': return 'accepted';
    case 'declined': return 'declined';
    case 'tentative':
    case 'tentativelyaccepted': return 'tentative';
    default: return 'needs-action';
  }
}

/** Alleen http(s)-links toestaan; onzin of te lange waarden vervallen naar null. */
export function sanitizeMeetingUrl(value: unknown): string | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw || raw.length > 2048) return null;
  try {
    const u = new URL(raw);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? raw : null;
  } catch { return null; }
}

// Externe agenda's (Google/Microsoft) hebben geen eigen veld voor een geplakte
// (bv. Zoom-)link. Die zetten we als herkenbare regel onderaan de omschrijving,
// zodat hij ook in Google Calendar / Outlook zichtbaar blijft, en lezen hem er
// bij het ophalen weer uit. Automatisch gegenereerde Meet/Teams-links komen uit
// het native conferentie-veld van de provider en gaan hier langs.
const MEETING_LINE_RE = /\n*[ \t]*(?:🎥[ \t]*)?Videocall:[ \t]*(https?:\/\/\S+)[ \t]*$/i;
const MEETING_HOST_RE = /https?:\/\/[^\s]*(?:meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|zoom\.us|zoom\.com)[^\s]*/i;

/** Voegt de geplakte link als aparte regel onderaan de omschrijving toe. */
export function withMeetingLine(description: string | null, url: string | null): string | null {
  const base = stripMeetingLine(description);
  if (!url) return base;
  return `${base ? `${base}\n\n` : ''}🎥 Videocall: ${url}`;
}

/** Verwijdert een eerder toegevoegde "Videocall:"-regel uit de omschrijving. */
export function stripMeetingLine(description: string | null): string | null {
  if (!description) return null;
  const cleaned = description.replace(MEETING_LINE_RE, '').replace(/\s+$/, '');
  return cleaned || null;
}

/** Leidt de videocall-link af: eerst de native conferentie, dan een geplakte regel of losse link. */
export function readMeetingUrl(nativeConference: string | null, description: string | null, location: string | null): string | null {
  if (nativeConference) return nativeConference;
  const marked = (description ?? '').match(MEETING_LINE_RE);
  if (marked) return marked[1];
  return (description ?? '').match(MEETING_HOST_RE)?.[0] ?? (location ?? '').match(MEETING_HOST_RE)?.[0] ?? null;
}

/** Videocall-link uit de eerste video-entrypoint van Google conferenceData. */
export function googleConferenceUrl(item: Record<string, unknown>): string | null {
  if (item.hangoutLink) return String(item.hangoutLink);
  const conf = (item.conferenceData ?? {}) as Record<string, unknown>;
  const entries = (conf.entryPoints ?? []) as Record<string, string>[];
  const video = entries.find(e => e.entryPointType === 'video') ?? entries[0];
  return video?.uri ? String(video.uri) : null;
}

// ── Datum-/tijd-helpers ─────────────────────────────────────────────────────

/** Given a date string "YYYY-MM-DD", return the next day as "YYYY-MM-DD". */
export function nextDay(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z'); // noon UTC avoids DST edge cases
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function providerDateKey(value?: string | null): string | null {
  if (!value) return null;
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

export function normalizeAllDayEventRange(startValue?: string | null, endExclusiveValue?: string | null): { starts_at: string; ends_at: string } {
  const startDate = providerDateKey(startValue) || new Date().toISOString().slice(0, 10);
  const rawEndExclusive = providerDateKey(endExclusiveValue) || nextDay(startDate);
  const endExclusive = rawEndExclusive <= startDate ? nextDay(startDate) : rawEndExclusive;
  return {
    starts_at: `${startDate}T00:00:00.000Z`,
    ends_at: `${endExclusive}T00:00:00.000Z`,
  };
}

export function normalizeMicrosoftDateTime(value: string): string {
  if (!value) return new Date().toISOString();
  return value.endsWith('Z') ? value : `${value}Z`;
}

export function toMicrosoftDateTime(value: string): string {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, '');
}

// ── Genodigden-mappers (Google/Microsoft → onze vorm) ───────────────────────

export function mapGoogleAttendees(payload: Record<string, unknown>): Array<{ email: string; name: string | null; status: string }> {
  const raw = (payload.attendees ?? []) as Record<string, unknown>[];
  return raw
    .filter(a => !a.organizer && !a.resource && a.email)
    .map(a => ({ email: String(a.email), name: a.displayName ? String(a.displayName) : null, status: mapAttendeeStatus(a.responseStatus) }));
}

export function mapMicrosoftAttendees(payload: Record<string, unknown>): Array<{ email: string; name: string | null; status: string }> {
  const raw = (payload.attendees ?? []) as Record<string, unknown>[];
  return raw
    .filter(a => a.type !== 'resource')
    .map(a => {
      const em = (a.emailAddress ?? {}) as Record<string, string>;
      const st = (a.status ?? {}) as Record<string, string>;
      return { email: String(em.address || ''), name: em.name ? String(em.name) : null, status: mapAttendeeStatus(st.response) };
    })
    .filter(a => a.email);
}

// ── RRULE (eenvoudige herhaling) ────────────────────────────────────────────

export function parseSimpleRrule(rrule: string | null): SimpleRrule | null {
  if (!rrule) return null;
  const parts = new Map<string, string>();
  for (const segment of rrule.split(';')) {
    const [key, value] = segment.split('=');
    if (key && value) parts.set(key.trim().toUpperCase(), value.trim());
  }
  const freqRaw = parts.get('FREQ');
  if (freqRaw !== 'DAILY' && freqRaw !== 'WEEKLY' && freqRaw !== 'MONTHLY') return null;
  const interval = Math.max(1, parseInt(parts.get('INTERVAL') || '1', 10) || 1);
  const untilRaw = parts.get('UNTIL');
  const countRaw = parts.get('COUNT');
  return {
    freq: freqRaw,
    interval,
    until: untilRaw ? rruleUntilToIso(untilRaw) : null,
    count: countRaw ? (parseInt(countRaw, 10) || null) : null,
  };
}

export function advanceRecurrence(date: Date, freq: 'DAILY' | 'WEEKLY' | 'MONTHLY', interval: number): Date {
  const next = new Date(date.getTime());
  if (freq === 'DAILY') next.setUTCDate(next.getUTCDate() + interval);
  else if (freq === 'WEEKLY') next.setUTCDate(next.getUTCDate() + 7 * interval);
  else next.setUTCMonth(next.getUTCMonth() + interval);
  return next;
}

// RRULE UNTIL "YYYYMMDDTHHMMSSZ" (of "YYYYMMDD") → ISO.
export function rruleUntilToIso(value: string): string | null {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/);
  if (!m) {
    const fallback = new Date(value);
    return Number.isNaN(fallback.getTime()) ? null : fallback.toISOString();
  }
  const [, y, mo, d, hh, mm, ss] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +(hh ?? 0), +(mm ?? 0), +(ss ?? 0))).toISOString();
}

export function isoToRruleUntil(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}

// Bouwt een RRULE-string uit een vrij RRULE-veld óf een eenvoudig
// {freq, interval, until, count}-object dat de frontend stuurt.
export function normalizeRrule(input: Record<string, unknown>): string | null {
  const raw = input.rrule;
  if (typeof raw === 'string' && raw.trim()) {
    return parseSimpleRrule(raw.trim()) ? raw.trim().toUpperCase() : null;
  }
  const rec = input.recurrence;
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as Record<string, unknown>;
  const freqMap: Record<string, string> = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY' };
  const freq = freqMap[String(r.freq || '').toLowerCase()];
  if (!freq) return null;
  const parts = [`FREQ=${freq}`];
  const interval = Number(r.interval);
  if (Number.isInteger(interval) && interval > 1) parts.push(`INTERVAL=${interval}`);
  if (r.until) {
    const until = new Date(String(r.until));
    if (!Number.isNaN(until.getTime())) parts.push(`UNTIL=${isoToRruleUntil(until)}`);
  }
  const count = Number(r.count);
  if (Number.isInteger(count) && count > 0) parts.push(`COUNT=${count}`);
  return parts.join(';');
}

// ── Token-encryptie (AES-GCM, sleutel afgeleid via SHA-256) ─────────────────

async function encryptionKey(): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(TOKEN_ENCRYPTION_KEY));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encrypt(value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey();
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
  return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(encrypted))}`;
}

export async function decrypt(value: string): Promise<string> {
  const [ivRaw, dataRaw] = value.split('.');
  if (!ivRaw || !dataRaw) throw new Error('Token decryptieformaat is ongeldig.');
  const key = await encryptionKey();
  const iv = base64UrlDecode(ivRaw) as unknown as BufferSource;
  const data = base64UrlDecode(dataRaw) as unknown as BufferSource;
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(decrypted);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
