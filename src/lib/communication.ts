import type { ClientEmailThreadOverview, Priority, Ticket, TicketNote, TicketStatus } from '../types';

/**
 * Pure hulpfuncties voor de pagina Berichten: de gesprekkenlijst (klantmail én
 * tickets door elkaar), filteren, zoeken en de korte teksten in de lijst.
 * Bewust zonder React, zonder Supabase en zonder runtime-imports, zodat ze in
 * `npm test` (node --test) te controleren zijn. Hoe een ticket een gesprek
 * wordt, staat in `tickets.ts` (ticketConversation).
 */

/** De drie tabbladen van de pagina: alles, alleen ongelezen, en de opvangbak. */
export type CommunicationTab = 'all' | 'unread' | 'inbox';

/** Waar een gesprek vandaan komt: een mailwisseling of een ticket met tijdlijn. */
export type ConversationKind = 'email' | 'ticket';

interface ConversationBase {
  /** Unieke sleutel over beide soorten heen: `email:<threadId>` of `ticket:<ticketId>`. */
  key: string;
  kind: ConversationKind;
  id: string;
  clientId: string | null;
  clientName: string;
  subject: string;
  /** De regel onder het onderwerp: wie zei het laatst wat. */
  preview: string;
  /** Laatste activiteit (ISO); de lijst sorteert hierop, nieuwste bovenaan. */
  lastAt: string;
  /** Aantal ongelezen berichten (mail) of 1 als het ticket nieuwe klant-activiteit heeft. */
  unread: number;
  hasProblem: boolean;
  /** Alle tekst waar de zoekfunctie in mag kijken — bij een ticket dus ook élke notitie. */
  searchText: string;
}

export interface EmailConversation extends ConversationBase {
  kind: 'email';
  clientId: string;
  thread: ClientEmailThreadOverview;
}

export interface TicketConversation extends ConversationBase {
  kind: 'ticket';
  ticket: Ticket;
  /** Oudste eerst. */
  notes: TicketNote[];
  status: TicketStatus;
  priority: Priority;
}

export type Conversation = EmailConversation | TicketConversation;

/** Waarde in het klantfilter voor "alleen tickets zonder klant". */
export const NO_CLIENT = '__none__';

/** Een periode uit het datumfilter; 'custom' = eigen van/tot. */
export type DatePeriod = '' | 'today' | 'week' | 'month' | '30d' | '90d' | 'year' | 'custom';

export const DATE_PERIOD_OPTIONS: Array<{ value: DatePeriod; label: string }> = [
  { value: '', label: 'Alle datums' },
  { value: 'today', label: 'Vandaag' },
  { value: 'week', label: 'Deze week' },
  { value: 'month', label: 'Deze maand' },
  { value: '30d', label: 'Afgelopen 30 dagen' },
  { value: '90d', label: 'Afgelopen 90 dagen' },
  { value: 'year', label: 'Dit jaar' },
  { value: 'custom', label: 'Aangepast…' },
];

export interface ConversationFilter {
  tab: CommunicationTab;
  /** Vrije zoektekst; alle woorden moeten ergens voorkomen, in willekeurige volgorde. */
  query: string;
  /** Leeg = alle klanten; NO_CLIENT = alleen gesprekken zonder klant. */
  clientId: string;
  /** Leeg = mail én tickets. */
  kind: '' | ConversationKind;
  /** Datum (JJJJ-MM-DD, lokale tijd) waar de laatste activiteit op of ná moet liggen. */
  from: string | null;
  /** Datum (JJJJ-MM-DD, lokale tijd) waar de laatste activiteit op of vóór moet liggen. */
  to: string | null;
  /** Sleutels die de server als treffer teruggaf: tellen als match, ook als de lokaal geladen tekst het woord niet bevat. */
  matchKeys?: ReadonlySet<string>;
}

function normalize(value: string | null | undefined): string {
  return String(value ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** De zoektekst in losse, genormaliseerde woorden. */
export function queryWords(query: string | null | undefined): string[] {
  return normalize(query).split(/\s+/).filter(Boolean);
}

/** Komen álle woorden ergens in de tekst voor (zonder hoofdletters en accenten)? */
export function matchesWords(text: string | null | undefined, words: readonly string[]): boolean {
  if (words.length === 0) return true;
  const haystack = normalize(text);
  return words.every(word => haystack.includes(word));
}

/** Een mailgesprek uit de view client_email_thread_overview als lijstregel. */
export function emailConversation(thread: ClientEmailThreadOverview): EmailConversation {
  return {
    key: `email:${thread.id}`,
    kind: 'email',
    id: thread.id,
    clientId: thread.client_id,
    clientName: thread.client_name,
    subject: thread.subject || '(geen onderwerp)',
    preview: previewLine(thread),
    lastAt: thread.last_message_at,
    unread: Math.max(0, thread.unread_count),
    hasProblem: thread.has_delivery_problem,
    searchText: [thread.client_name, thread.subject, thread.last_from_name, thread.last_from_email, thread.last_preview].filter(Boolean).join('\n'),
    thread,
  };
}

/** Nieuwste activiteit bovenaan; bij gelijke tijd blijft de volgorde stabiel. */
export function sortConversations<T extends Pick<Conversation, 'lastAt'>>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index, ms: Date.parse(item.lastAt) || 0 }))
    .sort((a, b) => (b.ms - a.ms) || (a.index - b.index))
    .map(entry => entry.item);
}

function localDayStart(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const ms = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Welke gesprekken staan er in de lijst? Tabblad, soort, klant en periode
 * snoeien eerst; daarna moeten alle zoekwoorden ergens voorkomen (klant,
 * onderwerp, afzender, preview — en bij een ticket in elke notitie). Een
 * gesprek dat de server als treffer teruggaf (`matchKeys`) telt altijd mee.
 * Het tabblad "Niet gekoppeld" toont geen gesprekken; die combinatie levert
 * bewust een lege lijst op.
 */
export function filterConversations<T extends Conversation>(items: readonly T[], filter: ConversationFilter): T[] {
  if (filter.tab === 'inbox') return [];
  const words = queryWords(filter.query);
  const fromMs = filter.from ? localDayStart(filter.from) : null;
  const toEnd = filter.to ? localDayStart(filter.to) : null;
  const toMs = toEnd == null ? null : toEnd + 86400000 - 1;
  return items.filter(item => {
    if (filter.tab === 'unread' && item.unread <= 0) return false;
    if (filter.kind && item.kind !== filter.kind) return false;
    if (filter.clientId === NO_CLIENT) { if (item.clientId !== null) return false; }
    else if (filter.clientId && item.clientId !== filter.clientId) return false;
    if (fromMs != null || toMs != null) {
      const ms = Date.parse(item.lastAt);
      if (!Number.isFinite(ms)) return false;
      if (fromMs != null && ms < fromMs) return false;
      if (toMs != null && ms > toMs) return false;
    }
    if (words.length === 0) return true;
    if (filter.matchKeys?.has(item.key)) return true;
    return matchesWords(item.searchText, words);
  });
}

function isoDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Van/tot voor een periode uit het datumfilter, in lokale dagen. "Deze week"
 * begint op maandag; "afgelopen 30 dagen" is vandaag plus de 29 dagen ervoor.
 * 'custom' en leeg geven geen grenzen: die vult de gebruiker zelf in.
 */
export function periodRange(period: DatePeriod, now: Date = new Date()): { from: string | null; to: string | null } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysAgo = (n: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - n);
  switch (period) {
    case 'today': return { from: isoDay(today), to: isoDay(today) };
    case 'week': {
      const offset = (today.getDay() + 6) % 7; // ma = 0 … zo = 6
      return { from: isoDay(daysAgo(offset)), to: isoDay(today) };
    }
    case 'month': return { from: isoDay(new Date(today.getFullYear(), today.getMonth(), 1)), to: isoDay(today) };
    case '30d': return { from: isoDay(daysAgo(29)), to: isoDay(today) };
    case '90d': return { from: isoDay(daysAgo(89)), to: isoDay(today) };
    case 'year': return { from: isoDay(new Date(today.getFullYear(), 0, 1)), to: isoDay(today) };
    default: return { from: null, to: null };
  }
}

/**
 * Een stukje tekst rond de eerste treffer, voor de regel "Gevonden: …" in de
 * lijst. Zoekt zonder hoofdletters en accenten, maar knipt uit de originele
 * tekst zodat de lezer ziet wat er echt staat. Niets gevonden → null.
 *
 * De aanloop (`before`) is bewust kort: de regel staat in een smalle kolom en
 * wordt rechts afgekapt, dus het gevonden woord moet vooraan staan — anders
 * lees je "…Vooral op de pagina met a" en zie je juist níét waarom het gesprek
 * in de lijst staat. Wat erna komt (`after`) mag langer; dat kapt de kolom af.
 */
export function searchSnippet(text: string | null | undefined, words: readonly string[], before = 18, after = 64): string | null {
  const source = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!source || words.length === 0) return null;
  // Per teken normaliseren houdt de posities gelijk: 'é' wordt 'e' (even
  // lang), en een teken dat na normaliseren van lengte zou veranderen (een
  // emoji, een ligatuur) blijft zoals het is. Zo wijst een index in de
  // genormaliseerde tekst naar hetzelfde teken in de originele tekst.
  const folded = Array.from(source, ch => { const n = normalize(ch); return n.length === ch.length ? n : ch; }).join('');
  let hitAt = -1;
  let hitLen = 0;
  for (const word of words) {
    const at = folded.indexOf(word);
    if (at >= 0 && (hitAt < 0 || at < hitAt)) { hitAt = at; hitLen = word.length; }
  }
  if (hitAt < 0) return null;
  let start = Math.max(0, hitAt - before);
  let end = Math.min(source.length, hitAt + hitLen + after);
  // Niet midden in een woord beginnen of eindigen als er een spatie in de buurt is.
  if (start > 0) { const space = source.lastIndexOf(' ', start + 12); if (space > start - 12 && space >= 0 && space < hitAt) start = space + 1; }
  if (end < source.length) { const space = source.indexOf(' ', end - 12); if (space >= 0 && space <= end + 12 && space > hitAt + hitLen) end = space; }
  return `${start > 0 ? '…' : ''}${source.slice(start, end).trim()}${end < source.length ? '…' : ''}`;
}

/**
 * De gesprekken van één klant in twee vensters: de mailwisselingen links, de
 * tickets rechts. Beide houden de volgorde die de lijst al had (nieuwste
 * activiteit bovenaan), zodat je in allebei de vensters op dezelfde manier
 * terugleest.
 */
export function splitConversations<T extends Conversation>(items: readonly T[]): { emails: T[]; tickets: T[] } {
  const emails: T[] = [];
  const tickets: T[] = [];
  for (const item of items) (item.kind === 'ticket' ? tickets : emails).push(item);
  return { emails, tickets };
}

/** Totaal aantal ongelezen over alle gesprekken (mail-berichten plus tickets met nieuwe klant-activiteit). */
export function countUnread(items: readonly Pick<Conversation, 'unread'>[]): number {
  return items.reduce((sum, item) => sum + Math.max(0, item.unread), 0);
}

/**
 * Onderwerp voor een antwoord: "Re: " ervoor, tenzij het er al staat — anders
 * krijg je "Re: Re: Re: offerte" na drie keer heen en weer. "Antw:" (Outlook
 * in het Nederlands) telt ook als al-beantwoord.
 */
export function replySubject(subject: string | null | undefined): string {
  const clean = String(subject ?? '').trim();
  if (!clean) return 'Re: (geen onderwerp)';
  if (/^(re|antw|aw)\s*:/i.test(clean)) return clean;
  return `Re: ${clean}`;
}

/** Voorletters voor het klantrondje in de lijst: "Bakkerij De Korenaar" → "BD". */
export function initials(name: string | null | undefined): string {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const letters = parts.length >= 2 ? `${parts[0][0]}${parts[1][0]}` : parts[0].slice(0, 2);
  return letters.toUpperCase();
}

/**
 * Korte naam van de afzender voor de previewregel: de voornaam uit de
 * weergavenaam, anders het deel vóór de @. De weergavenaam is vrij te kiezen
 * door de afzender en wordt daarom afgekapt.
 */
export function senderShortName(name: string | null | undefined, email: string | null | undefined): string {
  const clean = String(name ?? '').trim().slice(0, 60);
  if (clean) return clean.split(/\s+/)[0];
  const address = String(email ?? '').trim();
  if (!address) return 'Onbekend';
  return address.split('@')[0] || address;
}

/**
 * De previewregel onder het onderwerp. Bij een uitgaand bericht is de afzender
 * "wij" (het teamlid dat mailde is voor de lezer niet interessant), bij een
 * inkomend bericht de klant.
 */
export function previewLine(thread: Pick<ClientEmailThreadOverview, 'last_email_direction' | 'last_from_name' | 'last_from_email' | 'last_preview' | 'message_count'>): string {
  const text = String(thread.last_preview ?? '').trim();
  if (!thread.last_email_direction) return thread.message_count === 0 ? 'Nog geen berichten' : '';
  const body = text || '(geen tekst)';
  if (thread.last_email_direction === 'outbound') return `Jij: ${body}`;
  return `${senderShortName(thread.last_from_name, thread.last_from_email)}: ${body}`;
}

/**
 * Tijd zoals een postvak hem toont: vandaag alleen de tijd, deze week de dag,
 * anders de datum. Kort genoeg voor de smalle kolom in de gesprekkenlijst.
 */
export function listTime(value: string | null | undefined, now: Date = new Date()): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.floor((startOfToday.getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86400000);
  if (diffDays <= 0 && date.getTime() <= now.getTime() + 60000) {
    return new Intl.DateTimeFormat('nl-NL', { hour: '2-digit', minute: '2-digit' }).format(date);
  }
  if (diffDays === 1) return 'gisteren';
  if (diffDays > 1 && diffDays < 7) {
    return new Intl.DateTimeFormat('nl-NL', { weekday: 'short' }).format(date).replace('.', '');
  }
  if (date.getFullYear() === now.getFullYear()) {
    return new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short' }).format(date).replace('.', '');
  }
  return new Intl.DateTimeFormat('nl-NL', { day: '2-digit', month: '2-digit', year: '2-digit' }).format(date);
}
