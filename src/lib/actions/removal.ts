import {
  attachmentLockReason, clientHasFinanceDocuments, deleteAttachment, deleteCampaign, deleteClientCall, deleteClientContact,
  deleteClientEmail, deleteContentFolder, deleteEntityCascade, deleteFlow, deletePlannerNote, deleteProjectTemplate,
  deleteSavedReport, deleteTicketNote, deleteTimeEntry, draftDeleteBlockReason, loadAttachmentRef,
} from '../repository';
import { deleteBookingLink } from '../meetingBookingApi';
import { deleteRecording, getRecording } from '../meeting-api';
import { deleteAiReport } from '../aiReports';
import { folderDescendantIds } from '../folders';
import { optText, text, type ActionExecutor } from './types';

/**
 * Uitvoerders voor VERWIJDEREN (zie `supabase/functions/_shared/actions/removal.ts`).
 *
 * Elke uitvoerder hoort bij één handeling en kent zijn eigen tabel: de tabel
 * komt NIET uit het voorstel. Een voorstel is een momentopname uit de database,
 * maar een uitvoerder die op een tabelnaam uit de payload vertrouwt, verwijdert
 * wat er in die payload staat. Hier kan "taak verwijderen" alleen een taak raken.
 *
 * Dezelfde functies als de knop "Verwijderen": `deleteEntityCascade` ruimt de
 * bijlagen mee op, en de database bewaakt daarna nog de bewaarplicht.
 */

const done = (payload: Record<string, unknown>, fallback: string) => `${optText(payload, 'label') ?? fallback} verwijderd`;

export const REMOVAL_EXECUTORS: Record<string, ActionExecutor> = {
  'task.delete': async (payload, ctx) => {
    await deleteEntityCascade('tasks', text(payload, 'id'), ctx.organizationId);
    return done(payload, 'Taak');
  },
  'project.delete': async (payload, ctx) => {
    await deleteEntityCascade('projects', text(payload, 'id'), ctx.organizationId);
    return done(payload, 'Project');
  },
  'client.delete': async (payload, ctx) => {
    const clientId = text(payload, 'id');
    // Opnieuw, vlak voor het verwijderen: een factuur die na de kaart is gemaakt,
    // zou anders zonder klant achterblijven (de koppeling gaat op leeg).
    if (await clientHasFinanceDocuments(clientId, ctx.organizationId)) {
      throw new Error('Deze klant heeft inmiddels offertes of facturen; die vallen onder de bewaarplicht. Zet de klant op inactief.');
    }
    await deleteEntityCascade('clients', clientId, ctx.organizationId);
    return done(payload, 'Klant');
  },
  'ticket.delete': async (payload, ctx) => {
    await deleteEntityCascade('tickets', text(payload, 'id'), ctx.organizationId);
    return done(payload, 'Ticket');
  },
  'note.delete': async (payload, ctx) => {
    await deleteEntityCascade('notes', text(payload, 'id'), ctx.organizationId);
    return done(payload, 'Notitie');
  },
  'document.delete': async (payload, ctx) => {
    await deleteEntityCascade('documents', text(payload, 'id'), ctx.organizationId);
    return done(payload, 'Document');
  },
  // Bij een concept eerst kijken of het nog een concept IS, vóór deleteEntityCascade
  // de bijlagen wist: weigert de database pas daarna, dan zijn die al weg.
  'invoice.delete_draft': async (payload, ctx) => {
    const invoiceId = text(payload, 'id');
    const blocked = await draftDeleteBlockReason('invoice', invoiceId, ctx.organizationId);
    if (blocked) throw new Error(blocked);
    await deleteEntityCascade('invoices', invoiceId, ctx.organizationId);
    return done(payload, 'Conceptfactuur');
  },
  'quote.delete_draft': async (payload, ctx) => {
    const quoteId = text(payload, 'id');
    const blocked = await draftDeleteBlockReason('quote', quoteId, ctx.organizationId);
    if (blocked) throw new Error(blocked);
    await deleteEntityCascade('quotes', quoteId, ctx.organizationId);
    return done(payload, 'Conceptofferte');
  },
  'week_action.delete': async (payload, ctx) => {
    await deletePlannerNote(ctx.organizationId, text(payload, 'id'));
    return done(payload, 'Actiepunt');
  },
  'project_template.delete': async (payload, ctx) => {
    await deleteProjectTemplate(ctx.organizationId, text(payload, 'id'));
    return done(payload, 'Sjabloon');
  },
  'time_entry.delete': async (payload, ctx) => {
    await deleteTimeEntry(ctx.organizationId, text(payload, 'id'));
    return done(payload, 'Urenpost');
  },
  'client_contact.delete': async (payload, ctx) => {
    await deleteClientContact(text(payload, 'id'), ctx.organizationId);
    return done(payload, 'Contactpersoon');
  },
  'client_call.delete': async (payload, ctx) => {
    await deleteClientCall(text(payload, 'id'), ctx.organizationId);
    return done(payload, 'Gesprek');
  },
  'client_email.delete': async (payload, ctx) => {
    await deleteClientEmail(ctx.organizationId, text(payload, 'id'));
    return `${optText(payload, 'label') ?? 'Mail'} uit het dossier gehaald`;
  },
  'ticket_note.delete': async (payload, ctx) => {
    await deleteTicketNote(text(payload, 'id'), ctx.organizationId);
    return done(payload, 'Reactie');
  },
  'folder.delete': async (payload, ctx) => {
    const folderId = text(payload, 'id');
    // Alleen de submappen van NU (de geladen werkruimte), net als de knop. De lijst
    // uit het voorstel niet: een submap die intussen ergens anders staat, hoort er
    // niet meer bij, en zijn bestanden mogen dan niet mee.
    const current = folderDescendantIds(ctx.data.folders ?? [], folderId);
    await deleteContentFolder(folderId, current, ctx.organizationId);
    return done(payload, 'Map');
  },
  'attachment.delete': async (payload, ctx) => {
    const ref = await loadAttachmentRef(text(payload, 'id'), ctx.organizationId);
    const locked = await attachmentLockReason(ref.entity_type, ref.entity_id, ctx.organizationId);
    if (locked) throw new Error(locked);
    await deleteAttachment(ref);
    return done(payload, 'Bestand');
  },
  'meeting_recording.delete': async (payload, ctx) => {
    const recording = await getRecording(text(payload, 'id'));
    if (!recording || recording.organization_id !== ctx.organizationId) throw new Error('Deze opname bestaat niet (meer).');
    await deleteRecording(ctx.organizationId, recording);
    return done(payload, 'Opname');
  },
  'booking_link.delete': async (payload, ctx) => {
    await deleteBookingLink(ctx.organizationId, text(payload, 'id'));
    return done(payload, 'Boekingslink');
  },
  'campaign.delete': async (payload, ctx) => {
    await deleteCampaign(ctx.organizationId, text(payload, 'id'));
    return done(payload, 'Campagne');
  },
  'flow.delete': async (payload, ctx) => {
    await deleteFlow(ctx.organizationId, text(payload, 'id'));
    return done(payload, 'Stroom');
  },
  'saved_report.delete': async (payload, ctx) => {
    await deleteSavedReport(ctx.organizationId, text(payload, 'id'));
    return done(payload, 'Rapport');
  },
  'ai_report.delete': async (payload, ctx) => {
    await deleteAiReport(ctx.organizationId, text(payload, 'id'));
    return done(payload, 'Rapportage');
  },
};
