import type { ClientEmailThreadOverview } from '../types';

/**
 * Pure hulpfuncties voor de pagina Berichten: filteren, zoeken en de korte
 * teksten in de gesprekkenlijst. Bewust zonder React en zonder Supabase,
 * zodat ze in `npm test` te controleren zijn.
 */

/** De drie tabbladen van de pagina: alles, alleen ongelezen, en de opvangbak. */
export type CommunicationTab = 'all' | 'unread' | 'inbox';

export interface ThreadFilter {
  tab: CommunicationTab;
  /** Vrije zoektekst: klant, onderwerp, afzender of de preview van het laatste bericht. */
  query: string;
  /** Leeg = alle klanten. */
  clientId: string;
}

function normalize(value: string | null | undefined): string {
  return String(value ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Welke gesprekken staan er in de lijst? Alle zoekwoorden moeten ergens
 * voorkomen (klantnaam, onderwerp, afzender of preview), in willekeurige
 * volgorde — "bakker offerte" vindt dus het gesprek "Re: offerte" met Bakkerij
 * De Korenaar. Het tabblad "Niet gekoppeld" toont geen gesprekken; die
 * combinatie levert bewust een lege lijst op.
 */
export function filterThreads(threads: ClientEmailThreadOverview[], filter: ThreadFilter): ClientEmailThreadOverview[] {
  if (filter.tab === 'inbox') return [];
  const words = normalize(filter.query).split(/\s+/).filter(Boolean);
  return threads.filter(thread => {
    if (filter.tab === 'unread' && thread.unread_count <= 0) return false;
    if (filter.clientId && thread.client_id !== filter.clientId) return false;
    if (words.length === 0) return true;
    const haystack = normalize([
      thread.client_name, thread.subject, thread.last_from_name, thread.last_from_email, thread.last_preview,
    ].filter(Boolean).join(' '));
    return words.every(word => haystack.includes(word));
  });
}

/** Totaal aantal ongelezen inkomende berichten over alle gesprekken. */
export function countUnread(threads: ClientEmailThreadOverview[]): number {
  return threads.reduce((sum, thread) => sum + Math.max(0, thread.unread_count), 0);
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
