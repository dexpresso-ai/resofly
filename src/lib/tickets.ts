import type { Priority, Ticket, TicketNote, TicketStatus } from '../types';
import type { TicketConversation } from './communication';

/**
 * Pure hulpfuncties rond tickets die op meer dan één scherm nodig zijn: de
 * ticketlijst, het tabblad Tickets in het klantdossier en de pagina Berichten.
 * Bewust zonder React, zonder Supabase en zonder runtime-imports, zodat ze in
 * `npm test` (node --test) te controleren zijn en de labels maar op één plek
 * staan. `format.ts` leent zijn priorityLabel hiervandaan.
 */

export const TICKET_STATUS_ORDER: TicketStatus[] = ['new', 'review', 'approved', 'rejected', 'converted'];

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  new: 'Nieuw', review: 'Review', approved: 'Goedgekeurd', rejected: 'Geweigerd', converted: 'Omgezet',
};

export const TICKET_PRIORITY_LABELS: Record<Priority, string> = { high: 'Hoog', med: 'Normaal', low: 'Laag' };

export function ticketPriorityLabel(priority: Priority | string): string {
  return TICKET_PRIORITY_LABELS[priority as Priority] ?? 'Laag';
}

/** "Openstaand" = nog actief te behandelen: niet geweigerd en niet omgezet. */
export const TICKET_OPEN_STATUSES: ReadonlySet<TicketStatus> = new Set<TicketStatus>(['new', 'review', 'approved']);

export function ticketStatusLabel(status: TicketStatus | string): string {
  return TICKET_STATUS_LABELS[status as TicketStatus] ?? String(status);
}

/**
 * Statusfilter zoals de keuzelijsten hem aanbieden: leeg = alles, 'open' = de
 * drie actieve statussen, anders precies die ene status.
 */
export function ticketMatchesStatus(ticket: Pick<Ticket, 'status'>, filter: string): boolean {
  if (!filter) return true;
  if (filter === 'open') return TICKET_OPEN_STATUSES.has(ticket.status);
  return ticket.status === filter;
}

/** Notities per ticket, in de volgorde waarin ze geplaatst zijn (oudste eerst). */
export function groupNotesByTicket(notes: readonly TicketNote[]): Map<string, TicketNote[]> {
  const map = new Map<string, TicketNote[]>();
  for (const note of notes) {
    const list = map.get(note.ticket_id) ?? [];
    list.push(note);
    map.set(note.ticket_id, list);
  }
  for (const list of map.values()) list.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  return map;
}

/**
 * Wanneer er voor het laatst iets in het gesprek gebeurde: het ticket zelf of
 * de laatste notitie op de tijdlijn. Een statuswijziging telt bewust niet mee;
 * daar leest niemand iets nieuws van.
 */
export function ticketLastActivity(ticket: Pick<Ticket, 'created_at'>, notes: readonly TicketNote[]): string {
  let last = ticket.created_at;
  let lastMs = Date.parse(ticket.created_at);
  for (const note of notes) {
    const ms = Date.parse(note.created_at);
    if (Number.isFinite(ms) && (!Number.isFinite(lastMs) || ms > lastMs)) { last = note.created_at; lastMs = ms; }
  }
  return last;
}

/**
 * Korte naam van wie de notitie plaatste, voor een previewregel. Een teamlid
 * schrijft zijn e-mailadres als naam weg; daar tonen we het deel vóór de @.
 * Jouw eigen notities heten "Jij".
 */
export function noteAuthorShort(note: Pick<TicketNote, 'author_type' | 'author_user_id' | 'author_name'>, currentUserId?: string | null): string {
  if (note.author_type !== 'client' && currentUserId && note.author_user_id === currentUserId) return 'Jij';
  const raw = String(note.author_name ?? '').trim().slice(0, 60);
  if (!raw) return note.author_type === 'client' ? 'Klant' : 'Teamlid';
  const beforeAt = raw.includes('@') ? raw.split('@')[0] : raw;
  return beforeAt.split(/\s+/)[0] || (note.author_type === 'client' ? 'Klant' : 'Teamlid');
}

function oneLine(value: string | null | undefined, max = 200): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Een ticket mét zijn tijdlijn als regel in de gesprekkenlijst van Berichten.
 * De previewregel is de laatste notitie ("Maria: Vooral op de
 * afsprakenpagina…", "Jij: We kijken ernaar"); zonder notities de
 * omschrijving. De zoektekst bevat élke notitie, ook de interne — de pagina
 * is er voor het team.
 */
export function ticketConversation(
  ticket: Ticket,
  notes: readonly TicketNote[],
  options: { clientName: string | null; unread: boolean; currentUserId?: string | null },
): TicketConversation {
  const sorted = [...notes].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const last = sorted[sorted.length - 1];
  const preview = last
    ? `${noteAuthorShort(last, options.currentUserId)}: ${oneLine(last.body) || '(geen tekst)'}`
    : (oneLine(ticket.description) || 'Nog geen reacties');
  const clientName = options.clientName || 'Geen klant';
  return {
    key: `ticket:${ticket.id}`,
    kind: 'ticket',
    id: ticket.id,
    clientId: ticket.client_id,
    clientName,
    subject: ticket.title || '(geen titel)',
    preview,
    lastAt: ticketLastActivity(ticket, sorted),
    unread: options.unread ? 1 : 0,
    hasProblem: false,
    searchText: [
      clientName, ticket.title, ticket.description, ticket.notes,
      ticketStatusLabel(ticket.status), ticketPriorityLabel(ticket.priority),
      // "Maria Jansen: Vooral op de pagina…" — zo leest het fragment "Gevonden: …" als een zin.
      ...sorted.map(note => [note.author_name, note.body].filter(Boolean).join(': ')),
    ].filter(Boolean).join('\n'),
    ticket,
    notes: sorted,
    status: ticket.status,
    priority: ticket.priority,
  };
}
