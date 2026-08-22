import { convertTicketToProject, markTicketRead, setTicketNoteInternal, updateRow } from '../repository';
import { flag, list, optText, text, type ActionExecutor } from './types';

/**
 * Uitvoerders voor de ticket-handelingen. Elke functie doet precies wat de knop in
 * het ticketscherm doet — zie `supabase/functions/_shared/actions/tickets.ts` voor
 * wat er aan de gebruiker beloofd wordt op de kaart die hij goedkeurt.
 */
export const TICKETS_EXECUTORS: Record<string, ActionExecutor> = {
  'ticket.set_client': async (payload, ctx) => {
    const ticketId = text(payload, 'ticket_id');
    // Leeg client_id is hier een geldige waarde: dat is "Geen klant" in het formulier.
    const clientId = optText(payload, 'client_id');
    await updateRow('tickets', ticketId, { client_id: clientId }, ctx.organizationId);
    const title = optText(payload, 'ticket_title') ?? 'Ticket';
    const clientName = optText(payload, 'client_name');
    return clientName
      ? `Ticket "${title}" gekoppeld aan ${clientName}`
      : `Ticket "${title}" losgemaakt van de klant`;
  },

  'ticket.convert_to_project': async (payload, ctx) => {
    const ticketId = text(payload, 'ticket_id');
    // De Postgres-functie doet de conversie atomair; die heeft het hele ticket nodig,
    // dus we pakken de rij zoals hij nu geladen is — net als de knop in het scherm.
    const ticket = ctx.data.tickets.find((t) => t.id === ticketId);
    if (!ticket) throw new Error('Dit ticket staat niet in de geladen werkruimte. Ververs de pagina en probeer het opnieuw.');
    const project = await convertTicketToProject(ticket, ctx.organizationId);
    return `Ticket "${ticket.title}" omgezet naar project "${project.name}"`;
  },

  'ticket.mark_read': async (payload) => {
    const ticketIds = list(payload, 'ticket_ids');
    const titles = Array.isArray(payload.titles) ? (payload.titles as unknown[]).map(String) : [];
    // Per ticket, zodat één mislukte markering de rest niet meesleept en je aan de
    // melding ziet welke er wél doorheen zijn.
    const failed: string[] = [];
    for (let i = 0; i < ticketIds.length; i += 1) {
      try { await markTicketRead(ticketIds[i]); }
      catch { failed.push(titles[i] ?? ticketIds[i]); }
    }
    if (failed.length) throw new Error(`${ticketIds.length - failed.length} gemarkeerd, ${failed.length} mislukt (${failed.join(', ')}).`);
    if (ticketIds.length === 1) {
      return titles[0] ? `Ticket "${titles[0]}" als gelezen gemarkeerd` : 'Ticket als gelezen gemarkeerd';
    }
    return `${ticketIds.length} tickets als gelezen gemarkeerd`;
  },

  'ticket_note.set_visibility': async (payload, ctx) => {
    const noteId = text(payload, 'note_id');
    const internal = flag(payload, 'is_internal');
    await setTicketNoteInternal(noteId, internal, ctx.organizationId);
    const title = optText(payload, 'ticket_title') ?? 'het ticket';
    return internal
      ? `Notitie bij "${title}" is weer intern — de klant ziet hem niet meer in het portaal`
      : `Notitie bij "${title}" staat nu zichtbaar voor de klant in het portaal`;
  },
};
