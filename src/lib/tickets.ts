import type { Priority, Ticket, TicketNote, TicketStatus } from '../types';
import type { TicketConversation } from './communication';

/**
 * Pure hulpfuncties rond tickets die op meer dan één scherm nodig zijn: de
 * ticketlijst, het tabblad Tickets in het klantdossier en de pagina Berichten.
 * Bewust zonder React, zonder Supabase en zonder runtime-imports, zodat ze in
 * `npm test` (node --test) te controleren zijn en de labels maar op één plek
 * staan. `format.ts` leent zijn priorityLabel hiervandaan.
 */

export const TICKET_STATUS_ORDER: TicketStatus[] = ['new', 'review', 'approved', 'rejected', 'converted', 'resolved'];

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  new: 'Nieuw', review: 'Review', approved: 'Goedgekeurd', rejected: 'Geweigerd', converted: 'Omgezet', resolved: 'Afgehandeld',
};

export const TICKET_PRIORITY_LABELS: Record<Priority, string> = { high: 'Hoog', med: 'Normaal', low: 'Laag' };

export function ticketPriorityLabel(priority: Priority | string): string {
  return TICKET_PRIORITY_LABELS[priority as Priority] ?? 'Laag';
}

/** "Openstaand" = nog actief te behandelen: niet geweigerd, niet omgezet en niet afgehandeld. */
export const TICKET_OPEN_STATUSES: ReadonlySet<TicketStatus> = new Set<TicketStatus>(['new', 'review', 'approved']);

export function ticketStatusLabel(status: TicketStatus | string): string {
  return TICKET_STATUS_LABELS[status as TicketStatus] ?? String(status);
}

/* ── Werklijst en archief ──────────────────────────────────────────────────
 * Een afgehandeld ticket hoort niet meer tussen het werk. Zonder deze status
 * bleef alles op de lijst staan, ook wat allang beantwoord was, en zocht je
 * het werk ertussenuit. Afgehandeld gaat daarom naar het archief, op de
 * ticketpagina en in het klantdossier; daar is het terug te lezen en met één
 * klik te heropenen. De andere statussen blijven op de werklijst, ook
 * geweigerd en omgezet: daar is niet om gevraagd, en ze tellen in de
 * statuskaarten bovenaan mee.
 *
 * Reageert de klant in het portaal op een afgehandeld ticket, dan zet de
 * database het terug op review (20261105020000_ticket_resolved_archive.sql).
 * Dan staat het vanzelf weer op de werklijst en raakt zijn bericht niet zoek. */

/** De statussen van de werklijst, in de volgorde van de statuskaarten en keuzelijsten. */
export const TICKET_WORKLIST_STATUSES: TicketStatus[] = TICKET_STATUS_ORDER.filter(status => status !== 'resolved');

/** Heropenen zet een ticket hierop: weer in behandeling, niet "nieuw" — het is al eens bekeken. */
export const TICKET_REOPEN_STATUS: TicketStatus = 'review';

export type TicketScope = 'worklist' | 'archive';

/** Staat dit ticket in het archief? */
export function isTicketArchived(ticket: Pick<Ticket, 'status'>): boolean {
  return ticket.status === 'resolved';
}

export function ticketInScope(ticket: Pick<Ticket, 'status'>, scope: TicketScope): boolean {
  return scope === 'archive' ? isTicketArchived(ticket) : !isTicketArchived(ticket);
}

/**
 * Kan dit ticket met één klik op afgehandeld? Niet als het al afgehandeld is,
 * en niet als het een project werd: dan zet de database de status toch terug
 * op omgezet (normalize_ticket_conversion_state).
 */
export function canResolveTicket(ticket: Pick<Ticket, 'status' | 'converted_to_project_id'>): boolean {
  return ticket.status !== 'resolved' && ticket.status !== 'converted' && !ticket.converted_to_project_id;
}

/**
 * Wanneer het ticket afgehandeld werd, voor de volgorde en de datum in het
 * archief. resolved_at zet de database; een rij van vóór die kolom (of uit een
 * app die nog niet ververst is) valt terug op de laatste wijziging.
 */
export function ticketResolvedAt(ticket: Pick<Ticket, 'created_at' | 'updated_at'> & { resolved_at?: string | null }): string {
  return ticket.resolved_at || ticket.updated_at || ticket.created_at;
}

/** Het archief: laatst afgehandeld bovenaan. */
export function sortArchivedTickets<T extends Pick<Ticket, 'created_at' | 'updated_at'> & { resolved_at?: string | null }>(tickets: readonly T[]): T[] {
  return [...tickets].sort((a, b) => (Date.parse(ticketResolvedAt(b)) || 0) - (Date.parse(ticketResolvedAt(a)) || 0));
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

/* ── Opslaan vanuit het ticketvenster ──────────────────────────────────────
 * Het venster vult zijn velden één keer, bij het openen. Stuurde Opslaan alle
 * velden mee, dan zette een venster dat open stond terwijl de klant reageerde
 * (de database zet het ticket dan terug op Review) het ticket met de oude
 * status weer op Afgehandeld. De reactie verdween in het archief en de klant
 * kreeg meteen een mail "afgehandeld". Hetzelfde tussen twee collega's.
 * Daarom alleen wat in het venster veranderde, gemeten tegen het ticket zoals
 * het venster het opende (bij een voorstel van Gerrie: vóór zijn wijzigingen).
 */

/** Leeg, null en ontbrekend zijn in het formulier hetzelfde. */
function formValue(value: unknown): unknown {
  return value === undefined || value === null || value === '' ? null : value;
}

export function changedTicketValues(values: Record<string, unknown>, baseline: Partial<Ticket>): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (formValue(value) !== formValue((baseline as Record<string, unknown>)[key])) changed[key] = value;
  }
  return changed;
}

/**
 * Hangt het team een ticket aan een andere klant, dan ziet die klant in het
 * portaal de omschrijving en alles wat al zichtbaar op de tijdlijn staat, ook
 * wat de vorige klant schreef. Dat kan de bedoeling zijn (het ticket stond bij
 * de verkeerde klant), maar het mag geen verrassing zijn. Geeft de vraag voor
 * een bevestiging, of null als er niets naar een nieuwe klant gaat.
 */
export function ticketClientChangeWarning(
  baseline: Pick<Ticket, 'client_id' | 'description'>,
  nextClientId: unknown,
  visibleNotes: number,
  clientName: (clientId: string) => string,
): string | null {
  const next = typeof nextClientId === 'string' && nextClientId.trim() ? nextClientId.trim() : null;
  if (!next || next === (baseline.client_id ?? null)) return null;
  const hasDescription = Boolean(String(baseline.description ?? '').trim());
  if (visibleNotes <= 0 && !(baseline.client_id && hasDescription)) return null;
  const name = clientName(next);
  const parts = [hasDescription ? 'de omschrijving' : null, visibleNotes > 0 ? `${visibleNotes} zichtbare bericht${visibleNotes === 1 ? '' : 'en'} op de tijdlijn` : null]
    .filter(Boolean)
    .join(' en ');
  return `${name} ziet dit ticket daarna in het klantportaal, met ${parts}`
    + `${baseline.client_id ? `, ook wat ${clientName(baseline.client_id)} schreef` : ''}.`
    + ` Hoort dat gesprek niet bij ${name}, maak dan liever een nieuw ticket. Toch koppelen?`;
}
