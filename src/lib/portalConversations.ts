import type { PortalMessageThreadSummary, PortalTicket } from './portalApi';

/**
 * Pure hulpfuncties voor het klantportaal: de gesprekkenlijst onder
 * "Berichten" (mailgesprekken en tickets door elkaar, zoals de pagina
 * Berichten van het team), de deeplinks uit de meldingsmails, en het inkorten
 * van een geciteerde eerdere mail onder een antwoord. Zonder React en zonder
 * Supabase (alleen type-imports), zodat `npm test` ze controleert.
 */

export type PortalConversation =
  | {
      kind: 'thread';
      id: string;
      title: string;
      lastAt: string;
      preview: string;
      unread: boolean;
      thread: PortalMessageThreadSummary;
    }
  | {
      kind: 'ticket';
      id: string;
      title: string;
      lastAt: string;
      preview: string;
      unread: boolean;
      status: string;
      ticket: PortalTicket;
    };

/** Sleutel waarmee het scherm onthoudt dat je iets net geopend hebt. */
export function seenKey(kind: 'ticket' | 'thread', id: string): string {
  return `${kind}:${id}`;
}

/** Heeft de leverancier geantwoord sinds je dit ticket opende? */
export function isTicketUnread(ticket: Pick<PortalTicket, 'id' | 'unread'>, seen: ReadonlySet<string>): boolean {
  return ticket.unread === true && !seen.has(seenKey('ticket', ticket.id));
}

export function isThreadUnread(thread: Pick<PortalMessageThreadSummary, 'id' | 'unread'>, seen: ReadonlySet<string>): boolean {
  return thread.unread === true && !seen.has(seenKey('thread', thread.id));
}

/** Mailgesprekken en tickets in één lijst, laatste activiteit bovenaan. */
export function portalConversations(
  tickets: readonly PortalTicket[],
  threads: readonly PortalMessageThreadSummary[],
  supplierName: string,
  seen: ReadonlySet<string> = new Set(),
): PortalConversation[] {
  const items: PortalConversation[] = [
    ...threads.map((thread): PortalConversation => ({
      kind: 'thread',
      id: thread.id,
      title: thread.subject,
      lastAt: thread.lastMessageAt,
      preview: threadPreview(thread, supplierName),
      unread: isThreadUnread(thread, seen),
      thread,
    })),
    ...tickets.map((ticket): PortalConversation => ({
      kind: 'ticket',
      id: ticket.id,
      title: ticket.title,
      lastAt: ticket.last_activity_at || ticket.updated_at || ticket.created_at,
      preview: ticketPreview(ticket, supplierName),
      unread: isTicketUnread(ticket, seen),
      status: ticket.status,
      ticket,
    })),
  ];
  return items.sort((a, b) => (Date.parse(b.lastAt) || 0) - (Date.parse(a.lastAt) || 0));
}

/** "Studio Lopik: We kijken ernaar" — wie het laatst iets zei, en wat. */
export function threadPreview(thread: Pick<PortalMessageThreadSummary, 'lastFrom' | 'lastFromName' | 'lastPreview'>, supplierName: string): string {
  const who = thread.lastFrom === 'me'
    ? 'Jij'
    : thread.lastFrom === 'team'
      ? (thread.lastFromName || supplierName)
      : (thread.lastFromName || 'Collega');
  return thread.lastPreview ? `${who}: ${thread.lastPreview}` : who;
}

export function ticketPreview(ticket: Pick<PortalTicket, 'last_reply_from' | 'last_reply_author' | 'last_reply_preview' | 'description'>, supplierName: string): string {
  if (ticket.last_reply_preview) {
    const who = ticket.last_reply_from === 'team' ? supplierName : (ticket.last_reply_author || 'Klant');
    return `${who}: ${ticket.last_reply_preview}`;
  }
  const description = String(ticket.description ?? '').replace(/\s+/g, ' ').trim();
  return description ? description.slice(0, 140) : 'Nog geen reacties';
}

// ── Deeplinks uit de meldingsmail ─────────────────────────────────────────

export type PortalView = 'settings' | 'messages' | 'tickets';

export interface PortalLink {
  /** Het klantdossier (clientId); belangrijk als iemand bij meer leveranciers klant is. */
  dossier: string | null;
  ticket: string | null;
  thread: string | null;
  view: PortalView | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIEWS: Record<string, PortalView> = { instellingen: 'settings', berichten: 'messages', tickets: 'tickets' };

/**
 * Leest ?dossier=…&ticket=… (of &bericht=…, of &view=instellingen) uit de URL.
 * Alles wat geen geldige id of bekende weergave is, telt niet mee; zonder
 * bruikbare parameter is er geen link.
 */
export function parsePortalLink(search: string): PortalLink | null {
  const params = new URLSearchParams(search);
  const id = (name: string) => {
    const value = (params.get(name) ?? '').trim();
    return UUID.test(value) ? value.toLowerCase() : null;
  };
  const viewParam = (params.get('view') ?? '').trim().toLowerCase();
  const link: PortalLink = {
    dossier: id('dossier'),
    ticket: id('ticket'),
    thread: id('bericht'),
    view: Object.prototype.hasOwnProperty.call(VIEWS, viewParam) ? VIEWS[viewParam] : null,
  };
  return link.dossier || link.ticket || link.thread || link.view ? link : null;
}

/** Hoe lang een bewaarde link (van vóór het inloggen) nog geldt. */
export const PORTAL_LINK_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * Een link die tot na het inloggen in localStorage stond, opnieuw keuren: wat
 * van de schijf van de bezoeker komt is geen URL-parameter meer, en gaat
 * daarom door dezelfde zeef.
 */
export function revalidatePortalLink(value: unknown): PortalLink | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const params = new URLSearchParams();
  if (typeof raw.dossier === 'string') params.set('dossier', raw.dossier);
  if (typeof raw.ticket === 'string') params.set('ticket', raw.ticket);
  if (typeof raw.thread === 'string') params.set('bericht', raw.thread);
  const viewKey = Object.keys(VIEWS).find((key) => VIEWS[key] === raw.view);
  if (viewKey) params.set('view', viewKey);
  return parsePortalLink(`?${params.toString()}`);
}

// ── Geciteerde eerdere mail onder een antwoord ────────────────────────────

// "Op za 3 okt 2026 om 10:00 schreef Gerjan <gerjan@x.nl>:", "On Sat, Oct 3, 2026
// at 10:00 AM Gerjan <g@x.nl> wrote:" en de Duitse/Franse varianten. Alleen met
// een adres, tijd of jaartal erin: "Op de website schreef je het volgende:" is
// een gewone zin.
const REPLY_HEADER = /^\s*(op|on|am|le)\s.{4,300}\b(schreef|wrote|schrieb|a écrit)\b.{0,200}:\s*$/i;
const HEADER_DETAIL = /@|\d{1,2}:\d{2}|\b(19|20)\d{2}\b/;
const SEPARATORS = [
  /^\s*-{2,}\s*(oorspronkelijk bericht|original message|originalnachricht|message d'origine)\s*-{2,}\s*$/i,
  /^\s*_{8,}\s*$/,
];
const OUTLOOK_FROM = /^\s*\*?(van|from|von|de)\s*:\*?\s+\S/i;
const OUTLOOK_NEXT = /^\s*\*?(verzonden|sent|datum|date|gesendet|envoyé|aan|to|an|à)\s*:/i;

function isReplyHeader(line: string): boolean {
  return REPLY_HEADER.test(line) && HEADER_DETAIL.test(line);
}

/**
 * Splitst een antwoord in wat de klant nu schreef en de eerdere mail die het
 * mailprogramma eronder citeert. Zo staat in het gesprek niet bij elk bericht
 * de hele geschiedenis nog eens; het citaat blijft uitklapbaar. Herkent het
 * niets, dan blijft de tekst heel.
 */
export function splitQuotedReply(text: string): { main: string; quoted: string | null } {
  const source = String(text ?? '').replace(/\r\n?/g, '\n');
  const lines = source.split('\n');

  let cut = -1;
  for (let i = 0; i < lines.length && cut < 0; i += 1) {
    const line = lines[i];
    // Gmail breekt de "schreef"-regel soms over twee regels af.
    const joined = i + 1 < lines.length ? `${line} ${lines[i + 1]}` : line;
    if (isReplyHeader(line) || SEPARATORS.some((re) => re.test(line))) cut = i;
    else if (/^\s*(op|on|am|le)\s/i.test(line) && isReplyHeader(joined)) cut = i;
    else if (OUTLOOK_FROM.test(line) && lines.slice(i + 1, i + 5).some((next) => OUTLOOK_NEXT.test(next))) cut = i;
  }

  // Zonder kopregel: een blok '>'-regels dat tot het einde doorloopt.
  if (cut < 0) {
    let start = lines.length;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (/^\s*>/.test(lines[i])) start = i;
      else if (lines[i].trim() === '' && start === i + 1) continue;
      else break;
    }
    if (start < lines.length && lines.slice(start).some((line) => /^\s*>/.test(line))) cut = start;
  }

  if (cut < 0) return { main: source.trim(), quoted: null };
  const main = lines.slice(0, cut).join('\n').trim();
  const quoted = lines.slice(cut).join('\n').trim();
  if (!main || !quoted) return { main: source.trim(), quoted: null };
  return { main, quoted };
}
