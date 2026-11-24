import {
  ActionError, id, joinShort, orgQuery, row,
  type ActionCtx, type ActionDef, type ActionPlan,
} from './types.ts';
import { assertAttachmentParentOpen } from './content.ts';

/**
 * VERWIJDEREN — alles wat iets weggooit, op één plek.
 *
 * WAAROM HET NU KAN
 * De registry hield verwijderen eerst bewust buiten Gerrie ("een agent hoort
 * niets weg te gooien"). Daardoor kon hij een dubbele taak, een verkeerd
 * aangemaakte notitie of een concept dat niet doorgaat wel vinden, maar niet
 * opruimen: de gebruiker kreeg "dat kan ik niet" op iets wat de knop in het
 * scherm met één klik doet. De vraag was dat Gerrie alles kan wat de gebruiker
 * zelf mag.
 *
 * DE GRENZEN, VOOR ELKE HANDELING HIER
 *  • `risk: 'high'`: de knop op de kaart heet "Definitief uitvoeren", met een
 *    waarschuwing vooraan die zegt WAT er verdwijnt.
 *  • `humanOnly`: nooit rechtstreeks, ook niet voor een gekoppelde AI met
 *    `execute_high`. Er staat hier ook niets in `apply.ts`; dat blijft zo.
 *  • De bewaarplicht blijft staan. Een verstuurde of geboekte factuur, een
 *    offerte die naar de klant ging: die wis je niet, die herstel je met een
 *    creditnota of trek je in. `plan()` zegt dat vóór er een kaart komt; de
 *    database weigert het daarna ook nog (migraties 20260721 en 20261101090000).
 *  • Uitvoeren gebeurt in de browser, onder de sessie van wie goedkeurt, langs
 *    dezelfde functie als de knop "Verwijderen" — met RLS en modulerechten.
 */

const IRREVERSIBLE = 'Dit kun je niet ongedaan maken.';

/**
 * Een rapportage van Gerrie is van wie hem maakte (RLS: created_by = auth.uid()).
 * De handelingen draaien op de service-role, dus zoeken we hier zelf op de maker:
 * anders las een collega met het id de titel van een privérapport, en meldde een
 * hernoeming succes terwijl RLS hem bij het uitvoeren stil tegenhield.
 */
async function ownAiReport(ctx: ActionCtx, reportId: string): Promise<{ title: string }> {
  const { data, error } = await orgQuery(ctx, 'ai_reports', 'title').eq('id', reportId).eq('created_by', ctx.userId).maybeSingle();
  if (error) throw new ActionError(`Rapportage ophalen mislukt: ${error.message}`);
  if (!data) throw new ActionError('Rapportage niet gevonden onder jouw rapportages.');
  return data as { title: string };
}


function plan(fields: Omit<ActionPlan, 'kind'> & { kind?: ActionPlan['kind'] }): ActionPlan {
  return { kind: 'work', ...fields, risk: 'high', humanOnly: true };
}

/** Aantal rijen met een exacte telling (head-request), binnen de organisatie. */
async function exactCount(ctx: ActionCtx, table: string, column: string, value: string): Promise<number> {
  const { count, error } = await ctx.db.from(table).select('id', { count: 'exact', head: true })
    .eq('organization_id', ctx.organizationId).eq(column, value);
  if (error) throw new ActionError(`Tellen mislukt: ${error.message}`);
  return count ?? 0;
}

export const REMOVAL_ACTIONS: ActionDef[] = [
  // ── Projecten, taken en planning ──────────────────────────────────────────
  {
    id: 'task.delete',
    label: 'Een taak verwijderen',
    module: 'projects',
    kind: 'write',
    risk: 'high',
    description: 'Verwijdert een taak, met haar subtaken en bijlagen. Is de taak af of hoeft hij niet meer, overweeg dan de status "done" (propose_edit_task): die blijft terug te vinden. Zoek de taak met `list_tasks`.',
    keywords: ['taak', 'verwijderen', 'weggooien', 'wissen', 'dubbel', 'opruimen', 'schrappen'],
    input: { task_id: { type: 'string', description: 'Id van de taak (uit list_tasks).' } },
    required: ['task_id'],
    async plan(ctx, input) {
      const taskId = id(input, 'task_id');
      const task = await row<{ title: string; project_id: string | null; status: string }>(ctx, 'tasks', taskId, 'title, project_id, status', 'Taak');
      const project = task.project_id ? await row<{ name: string }>(ctx, 'projects', task.project_id, 'name', 'Project') : null;
      return plan({
        title: `Taak "${task.title}" verwijderen`,
        sub: joinShort([project?.name, `status ${task.status}`], 120),
        warning: `De taak, haar subtaken en bijlagen verdwijnen. ${IRREVERSIBLE}`,
        payload: { table: 'tasks', id: taskId, label: `Taak "${task.title}"` },
      });
    },
  },
  {
    id: 'project.delete',
    label: 'Een project verwijderen',
    module: 'projects',
    kind: 'write',
    risk: 'high',
    description: 'Verwijdert een project met al zijn taken en bijlagen. Wil je het alleen uit beeld hebben, archiveer het dan (propose_edit_project met archived=true): dan blijft alles bewaard. Zoek het project met `list_projects`.',
    keywords: ['project', 'verwijderen', 'weggooien', 'wissen', 'opruimen'],
    input: { project_id: { type: 'string', description: 'Id van het project (uit list_projects).' } },
    required: ['project_id'],
    async plan(ctx, input) {
      const projectId = id(input, 'project_id');
      const project = await row<{ name: string }>(ctx, 'projects', projectId, 'name', 'Project');
      const [tasks, invoices, quotes] = await Promise.all([
        exactCount(ctx, 'tasks', 'project_id', projectId),
        exactCount(ctx, 'invoices', 'project_id', projectId),
        exactCount(ctx, 'quotes', 'project_id', projectId),
      ]);
      return plan({
        title: `Project "${project.name}" verwijderen`,
        sub: joinShort([`${tasks} ta${tasks === 1 ? 'ak' : 'ken'}`, invoices + quotes > 0 ? `${invoices + quotes} offerte(s)/factu(u)r(en) blijven bestaan, los van het project` : null], 140),
        warning: `Het project en ${tasks === 0 ? 'zijn bijlagen' : `alle ${tasks} taken en bijlagen`} verdwijnen. Archiveren bewaart alles. ${IRREVERSIBLE}`,
        payload: { table: 'projects', id: projectId, label: `Project "${project.name}"` },
      });
    },
  },
  {
    id: 'week_action.delete',
    label: 'Een actiepunt uit de weekplanner verwijderen',
    module: 'projects',
    kind: 'write',
    risk: 'high',
    description: 'Haalt een eigen actiepunt van de "Actiepunten deze week"-lijst weg. Afvinken (week_action.set_done) bewaart hem juist. Alleen je eigen actiepunten. Zoek ze met `week_action.list`.',
    keywords: ['actiepunt', 'verwijderen', 'weekplanner', 'weghalen', 'schrappen'],
    input: { note_id: { type: 'string', description: 'Id van het actiepunt (uit week_action.list).' } },
    required: ['note_id'],
    async plan(ctx, input) {
      const noteId = id(input, 'note_id');
      const note = await row<{ text: string; user_id: string; week_start: string }>(ctx, 'planner_notes', noteId, 'text, user_id, week_start', 'Actiepunt');
      if (note.user_id !== ctx.userId) throw new ActionError('Dit actiepunt is van een collega; dat haal je niet weg.');
      return plan({
        title: `Actiepunt "${note.text}" verwijderen`,
        sub: `week van ${note.week_start}`,
        warning: IRREVERSIBLE,
        payload: { kind: 'planner_note', id: noteId, label: `Actiepunt "${note.text}"` },
      });
    },
  },
  {
    id: 'project_template.delete',
    label: 'Een projectsjabloon verwijderen',
    module: 'projects',
    kind: 'write',
    risk: 'high',
    description: 'Verwijdert een projectsjabloon met zijn taken. Projecten die er al mee gemaakt zijn, blijven zoals ze zijn. Liever niet meer aanbieden maar wel bewaren? Zet hem op inactief (project_template.update).',
    keywords: ['sjabloon', 'projectsjabloon', 'template', 'verwijderen'],
    input: { template_id: { type: 'string', description: 'Id van het sjabloon (uit project_template.list).' } },
    required: ['template_id'],
    async plan(ctx, input) {
      const templateId = id(input, 'template_id');
      const template = await row<{ name: string }>(ctx, 'project_templates', templateId, 'name', 'Sjabloon');
      return plan({
        title: `Projectsjabloon "${template.name}" verwijderen`,
        sub: 'bestaande projecten blijven zoals ze zijn',
        warning: IRREVERSIBLE,
        payload: { kind: 'project_template', id: templateId, label: `Sjabloon "${template.name}"` },
      });
    },
  },

  // ── Uren ──────────────────────────────────────────────────────────────────
  {
    id: 'time_entry.delete',
    label: 'Een urenregistratie verwijderen',
    module: 'time',
    kind: 'write',
    risk: 'high',
    description: 'Verwijdert een geregistreerde urenpost. Klopt alleen de duur of de datum niet, corrigeer hem dan (propose_edit_time_entry). Zoek de post met `list_time_entries`.',
    keywords: ['uren', 'urenregistratie', 'urenpost', 'verwijderen', 'dubbel', 'weghalen'],
    input: { time_entry_id: { type: 'string', description: 'Id van de urenpost (uit list_time_entries).' } },
    required: ['time_entry_id'],
    async plan(ctx, input) {
      const entryId = id(input, 'time_entry_id');
      const entry = await row<{ entry_date: string; minutes: number; description: string | null }>(ctx, 'time_entries', entryId, 'entry_date, minutes, description', 'Urenpost');
      return plan({
        title: `Urenpost van ${entry.entry_date} verwijderen`,
        sub: joinShort([`${Math.round(Number(entry.minutes ?? 0))} min`, entry.description], 120),
        warning: IRREVERSIBLE,
        payload: { kind: 'time_entry', id: entryId, label: `Urenpost van ${entry.entry_date}` },
      });
    },
  },

  // ── Klanten ───────────────────────────────────────────────────────────────
  {
    id: 'client.delete',
    label: 'Een klant verwijderen',
    module: 'clients',
    kind: 'write',
    risk: 'high',
    description: 'Verwijdert een klant met zijn dossier (contactpersonen, bijlagen). Een klant met offertes of facturen kan niet weg (bewaarplicht); zet hem dan op inactief (propose_edit_client met status inactive). Zoek de klant met `search_clients`.',
    keywords: ['klant', 'verwijderen', 'wissen', 'dubbel', 'opruimen', 'weggooien'],
    input: { client_id: { type: 'string', description: 'Id van de klant (uit search_clients).' } },
    required: ['client_id'],
    async plan(ctx, input) {
      const clientId = id(input, 'client_id');
      const client = await row<{ name: string }>(ctx, 'clients', clientId, 'name', 'Klant');
      const [invoices, quotes, projects] = await Promise.all([
        exactCount(ctx, 'invoices', 'client_id', clientId),
        exactCount(ctx, 'quotes', 'client_id', clientId),
        exactCount(ctx, 'projects', 'client_id', clientId),
      ]);
      if (invoices + quotes > 0) {
        throw new ActionError(`Deze klant heeft ${invoices} factu${invoices === 1 ? 'ur' : 'ren'} en ${quotes} offerte${quotes === 1 ? '' : 's'}; die vallen onder de bewaarplicht, dus de klant kan niet weg. Zet hem op inactief (propose_edit_client, status inactive).`);
      }
      return plan({
        title: `Klant "${client.name}" verwijderen`,
        sub: projects > 0 ? `${projects} project(en) blijven bestaan, zonder klant` : 'met contactpersonen en bijlagen',
        warning: `De klantkaart, contactpersonen en bijlagen verdwijnen. ${IRREVERSIBLE}`,
        payload: { table: 'clients', id: clientId, label: `Klant "${client.name}"` },
      });
    },
  },
  {
    id: 'client_contact.delete',
    label: 'Een contactpersoon verwijderen',
    module: 'clients',
    kind: 'write',
    risk: 'high',
    description: 'Verwijdert een contactpersoon van een klant. Heeft hij portaaltoegang, dan kan hij daarna niet meer inloggen. Werkt hij er alleen niet meer, zet hem dan liever op inactief (client_contact.set_active): dan blijft de geschiedenis kloppen.',
    keywords: ['contactpersoon', 'verwijderen', 'weghalen', 'wissen'],
    input: { contact_id: { type: 'string', description: 'Id van de contactpersoon (uit list_client_contacts).' } },
    required: ['contact_id'],
    async plan(ctx, input) {
      const contactId = id(input, 'contact_id');
      const contact = await row<{ name: string; client_id: string; gives_portal_access: boolean | null }>(ctx, 'client_contacts', contactId, 'name, client_id, gives_portal_access', 'Contactpersoon');
      const client = await row<{ name: string }>(ctx, 'clients', contact.client_id, 'name', 'Klant');
      return plan({
        title: `Contactpersoon ${contact.name} verwijderen`,
        sub: `bij ${client.name}${contact.gives_portal_access ? ' · heeft nu portaaltoegang' : ''}`,
        warning: `${contact.gives_portal_access ? 'Hij of zij kan daarna niet meer in het klantportaal. ' : ''}${IRREVERSIBLE}`,
        payload: { kind: 'client_contact', id: contactId, label: `Contactpersoon ${contact.name}` },
      });
    },
  },
  {
    id: 'client_call.delete',
    label: 'Een gelogd telefoongesprek verwijderen',
    module: 'clients',
    kind: 'write',
    risk: 'high',
    description: 'Verwijdert een gelogd telefoongesprek uit het dossier. Zoek het met `client_call.list`.',
    keywords: ['gesprek', 'telefoongesprek', 'verwijderen', 'weghalen'],
    input: { call_id: { type: 'string', description: 'Id van het gesprek (uit client_call.list).' } },
    required: ['call_id'],
    async plan(ctx, input) {
      const callId = id(input, 'call_id');
      const call = await row<{ subject: string; started_at: string; counterpart_name: string | null }>(ctx, 'client_calls', callId, 'subject, started_at, counterpart_name', 'Gesprek');
      return plan({
        title: `Gesprek "${call.subject || 'zonder onderwerp'}" verwijderen`,
        sub: joinShort([call.counterpart_name, String(call.started_at).slice(0, 10)], 120),
        warning: IRREVERSIBLE,
        payload: { kind: 'client_call', id: callId, label: `Gesprek "${call.subject || 'zonder onderwerp'}"` },
      });
    },
  },
  {
    id: 'client_email.delete',
    label: 'Een mail uit het klantdossier verwijderen',
    module: 'clients',
    kind: 'write',
    risk: 'high',
    description: 'Haalt een mail uit het dossier van een klant (bijvoorbeeld spam of een mail die bij de verkeerde klant terechtkwam). Hoort hij bij een andere klant, koppel hem dan liever opnieuw. Zoek de mail met `client_email.list`.',
    keywords: ['mail', 'e-mail', 'verwijderen', 'dossier', 'spam', 'weghalen'],
    input: { email_id: { type: 'string', description: 'Id van de mail (uit client_email.list).' } },
    required: ['email_id'],
    async plan(ctx, input) {
      const emailId = id(input, 'email_id');
      const mail = await row<{ subject: string | null; client_id: string | null; deleted_at: string | null; direction: string }>(ctx, 'client_emails', emailId, 'subject, client_id, deleted_at, direction', 'Mail');
      if (mail.deleted_at) throw new ActionError('Deze mail is al verwijderd.');
      return plan({
        title: `Mail "${mail.subject || '(zonder onderwerp)'}" uit het dossier halen`,
        sub: mail.direction === 'inbound' ? 'binnengekomen mail' : 'verstuurde mail',
        kind: 'mail',
        warning: IRREVERSIBLE,
        payload: { kind: 'client_email', id: emailId, label: `Mail "${mail.subject || '(zonder onderwerp)'}"` },
      });
    },
  },

  // ── Tickets ───────────────────────────────────────────────────────────────
  {
    id: 'ticket.delete',
    label: 'Een ticket verwijderen',
    module: 'tickets',
    kind: 'write',
    risk: 'high',
    description: 'Verwijdert een ticket met zijn tijdlijn en bijlagen. Is het afgehandeld, zet het dan liever op "resolved" (propose_edit_ticket): dan staat het in het archief. Zoek het ticket met `list_tickets`.',
    keywords: ['ticket', 'verwijderen', 'spam', 'dubbel', 'weggooien', 'wissen'],
    input: { ticket_id: { type: 'string', description: 'Id van het ticket (uit list_tickets).' } },
    required: ['ticket_id'],
    async plan(ctx, input) {
      const ticketId = id(input, 'ticket_id');
      const ticket = await row<{ title: string; status: string }>(ctx, 'tickets', ticketId, 'title, status', 'Ticket');
      const notes = await exactCount(ctx, 'ticket_notes', 'ticket_id', ticketId);
      return plan({
        title: `Ticket "${ticket.title}" verwijderen`,
        sub: joinShort([`status ${ticket.status}`, notes ? `${notes} reactie(s)` : null], 120),
        warning: `Het ticket, de reacties en bijlagen verdwijnen, ook uit het klantportaal. ${IRREVERSIBLE}`,
        payload: { table: 'tickets', id: ticketId, label: `Ticket "${ticket.title}"` },
      });
    },
  },
  {
    id: 'ticket_note.delete',
    label: 'Een reactie of notitie uit een ticket verwijderen',
    module: 'tickets',
    kind: 'write',
    risk: 'high',
    description: 'Haalt een reactie of interne notitie uit de tijdlijn van een ticket. Wil je alleen dat de klant hem niet meer ziet, maak hem dan intern (ticket_note.set_visibility). Zoek de notitie met `ticket.list_notes`.',
    keywords: ['ticket', 'reactie', 'notitie', 'verwijderen', 'tijdlijn', 'weghalen'],
    input: { note_id: { type: 'string', description: 'Id van de reactie (uit ticket.list_notes).' } },
    required: ['note_id'],
    async plan(ctx, input) {
      const noteId = id(input, 'note_id');
      const note = await row<{ body: string; is_internal: boolean; ticket_id: string; author_type: string | null }>(ctx, 'ticket_notes', noteId, 'body, is_internal, ticket_id, author_type', 'Reactie');
      const ticket = await row<{ title: string }>(ctx, 'tickets', note.ticket_id, 'title', 'Ticket');
      const preview = String(note.body ?? '').replace(/\s+/g, ' ').slice(0, 80);
      return plan({
        title: `${note.is_internal ? 'Interne notitie' : 'Reactie'} uit "${ticket.title}" verwijderen`,
        sub: `"${preview}${preview.length >= 80 ? '…' : ''}"${note.author_type === 'client' ? ' · geschreven door de klant' : ''}`,
        warning: `${note.is_internal ? '' : 'De klant ziet hem dan ook niet meer in het portaal. '}${IRREVERSIBLE}`,
        payload: { kind: 'ticket_note', id: noteId, label: 'Reactie' },
      });
    },
  },

  // ── Inhoud ────────────────────────────────────────────────────────────────
  {
    id: 'note.delete',
    label: 'Een notitie verwijderen',
    module: 'content',
    kind: 'write',
    risk: 'high',
    description: 'Verwijdert een notitie met haar bijlagen. Zoek hem met `content.search` of `list_content`.',
    keywords: ['notitie', 'verwijderen', 'weggooien', 'wissen', 'opruimen'],
    input: { note_id: { type: 'string', description: 'Id van de notitie.' } },
    required: ['note_id'],
    async plan(ctx, input) {
      const noteId = id(input, 'note_id');
      const note = await row<{ title: string | null }>(ctx, 'notes', noteId, 'title', 'Notitie');
      return plan({
        title: `Notitie "${note.title || 'zonder titel'}" verwijderen`,
        sub: 'met haar bijlagen',
        warning: IRREVERSIBLE,
        payload: { table: 'notes', id: noteId, label: `Notitie "${note.title || 'zonder titel'}"` },
      });
    },
  },
  {
    id: 'document.delete',
    label: 'Een document verwijderen',
    module: 'content',
    kind: 'write',
    risk: 'high',
    description: 'Verwijdert een intern document (ook een Word-document) met zijn bijlagen. Staat het gedeeld, dan ziet de ontvanger het daarna niet meer. Zoek het met `content.search` of `list_content`.',
    keywords: ['document', 'verwijderen', 'weggooien', 'wissen', 'opruimen'],
    input: { document_id: { type: 'string', description: 'Id van het document.' } },
    required: ['document_id'],
    async plan(ctx, input) {
      const documentId = id(input, 'document_id');
      const doc = await row<{ title: string | null; storage_key: string | null }>(ctx, 'documents', documentId, 'title, storage_key', 'Document');
      return plan({
        title: `Document "${doc.title || 'zonder titel'}" verwijderen`,
        sub: doc.storage_key ? 'Word-document, met bijlagen' : 'met bijlagen',
        warning: IRREVERSIBLE,
        payload: { table: 'documents', id: documentId, label: `Document "${doc.title || 'zonder titel'}"` },
      });
    },
  },
  {
    id: 'folder.delete',
    label: 'Een map verwijderen',
    module: 'content',
    kind: 'write',
    risk: 'high',
    description: 'Verwijdert een map en haar submappen. Notities en documenten erin blijven bestaan (ze staan daarna los); geüploade BESTANDEN in de map(pen) worden verwijderd. Zoek de map met `folder.list` of `content.search`.',
    keywords: ['map', 'verwijderen', 'opruimen', 'submap', 'weggooien'],
    input: { folder_id: { type: 'string', description: 'Id van de map.' } },
    required: ['folder_id'],
    async plan(ctx, input) {
      const folderId = id(input, 'folder_id');
      const folder = await row<{ name: string }>(ctx, 'content_folders', folderId, 'name', 'Map');
      // Submappen zelf zoeken, laag voor laag, binnen de organisatie.
      const all = [folderId];
      let frontier = [folderId];
      for (let depth = 0; depth < 10 && frontier.length > 0; depth += 1) {
        const { data, error } = await orgQuery(ctx, 'content_folders', 'id').in('parent_id', frontier).limit(500);
        if (error) throw new ActionError(`Submappen ophalen mislukt: ${error.message}`);
        frontier = ((data ?? []) as Array<{ id: string }>).map((f) => f.id).filter((fid) => !all.includes(fid));
        all.push(...frontier);
      }
      const { data: files, error: fileError } = await orgQuery(ctx, 'attachments', 'id').eq('entity_type', 'folder').in('entity_id', all).limit(1000);
      if (fileError) throw new ActionError(`Bestanden tellen mislukt: ${fileError.message}`);
      const fileCount = (files ?? []).length;
      const subCount = all.length - 1;
      return plan({
        title: `Map "${folder.name}" verwijderen`,
        sub: joinShort([subCount ? `${subCount} submap(pen)` : null, `${fileCount} bestand(en) gaan mee`, 'notities en documenten blijven bestaan'], 140),
        warning: `${fileCount > 0 ? `De ${fileCount} geüploade bestand(en) in deze map(pen) worden verwijderd. ` : ''}${IRREVERSIBLE}`,
        payload: { kind: 'folder', id: folderId, descendant_ids: all.slice(1), label: `Map "${folder.name}"` },
      });
    },
  },
  {
    id: 'attachment.delete',
    label: 'Een bestand (bijlage) verwijderen',
    module: 'content',
    kind: 'write',
    risk: 'high',
    description: 'Verwijdert een geüpload bestand, ook uit de opslag. Zoek het met `attachment.list` of `content.search`.',
    keywords: ['bestand', 'bijlage', 'verwijderen', 'weggooien', 'upload'],
    input: { attachment_id: { type: 'string', description: 'Id van het bestand.' } },
    required: ['attachment_id'],
    async plan(ctx, input) {
      const attachmentId = id(input, 'attachment_id');
      const file = await row<{ name: string; entity_type: string; entity_id: string }>(ctx, 'attachments', attachmentId, 'name, entity_type, entity_id', 'Bestand');
      const module = ({ folder: 'content', note: 'content', document: 'content', client: 'clients', project: 'projects', task: 'projects', subtask: 'projects', ticket: 'tickets', quote: 'finance', invoice: 'finance', supplier: 'finance', purchase_invoice: 'finance', fixed_asset: 'finance', meeting_recording: 'calendar' } as Record<string, string>)[file.entity_type];
      if (!module) throw new ActionError('Dit bestand hoort bij de teamchat; dat beheer je in de chat zelf.');
      if (ctx.canWrite?.(module) === false) throw new ActionError('Dit bestand hangt aan iets waar je niet mag wijzigen.');
      await assertAttachmentParentOpen(ctx, file.entity_type, file.entity_id);
      return plan({
        title: `Bestand "${file.name}" verwijderen`,
        sub: 'ook uit de opslag',
        warning: IRREVERSIBLE,
        payload: { kind: 'attachment', id: attachmentId, label: `Bestand "${file.name}"` },
      });
    },
  },

  // ── Agenda ────────────────────────────────────────────────────────────────
  {
    id: 'meeting_recording.delete',
    label: 'Een opname met transcript en notulen verwijderen',
    module: 'calendar',
    kind: 'write',
    risk: 'high',
    description: 'Verwijdert een gespreksopname: het geluid, het transcript en de notulen. Zoek hem met `meeting_recording.list`.',
    keywords: ['opname', 'transcript', 'notulen', 'verwijderen', 'avg', 'privacy', 'gesprek'],
    input: { recording_id: { type: 'string', description: 'Id van de opname.' } },
    required: ['recording_id'],
    async plan(ctx, input) {
      const recordingId = id(input, 'recording_id');
      const rec = await row<{ event_title_snapshot: string | null; created_at: string }>(ctx, 'meeting_recordings', recordingId, 'event_title_snapshot, created_at', 'Opname');
      return plan({
        title: `Opname "${rec.event_title_snapshot || 'zonder titel'}" verwijderen`,
        sub: `van ${String(rec.created_at).slice(0, 10)} · geluid, transcript en notulen`,
        kind: 'agenda',
        warning: IRREVERSIBLE,
        payload: { kind: 'meeting_recording', id: recordingId, label: `Opname "${rec.event_title_snapshot || 'zonder titel'}"` },
      });
    },
  },
  {
    id: 'booking_link.delete',
    label: 'Een boekingslink verwijderen',
    module: 'calendar',
    kind: 'write',
    risk: 'high',
    description: 'Verwijdert een boekingslink: wie de link heeft, kan er niet meer mee boeken. Is er al op geboekt, dan weigert ResoFly dat; zeg de afspraak dan eerst af (booking.cancel).',
    keywords: ['boekingslink', 'verwijderen', 'afspraaklink', 'weghalen'],
    input: { link_id: { type: 'string', description: 'Id van de boekingslink.' } },
    required: ['link_id'],
    async plan(ctx, input) {
      const linkId = id(input, 'link_id');
      const link = await row<{ title: string }>(ctx, 'meeting_booking_links', linkId, 'title', 'Boekingslink');
      // Dezelfde regel als de server: alleen afspraken die nog gelden, houden de link tegen.
      const { data: open, error: openError } = await orgQuery(ctx, 'meeting_bookings', 'id')
        .eq('booking_link_id', linkId).in('status', ['pending', 'confirmed']).limit(1);
      if (openError) throw new ActionError(`Afspraken ophalen mislukt: ${openError.message}`);
      if ((open ?? []).length > 0) throw new ActionError('Op deze link is al geboekt. Zeg die afspraak eerst af (booking.cancel), dan kan de link weg.');
      return plan({
        title: `Boekingslink "${link.title}" verwijderen`,
        sub: 'de link werkt daarna niet meer',
        kind: 'agenda',
        warning: IRREVERSIBLE,
        payload: { kind: 'booking_link', id: linkId, label: `Boekingslink "${link.title}"` },
      });
    },
  },

  // ── Verkoop: alleen concepten ─────────────────────────────────────────────
  {
    id: 'invoice.delete_draft',
    label: 'Een conceptfactuur verwijderen',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description: 'Verwijdert een factuur die nog CONCEPT is en nooit verstuurd of geboekt werd. Een verstuurde of geboekte factuur valt onder de bewaarplicht: die herstel je met een creditnota (invoice.credit). Zoek de factuur met `list_invoices`.',
    keywords: ['factuur', 'concept', 'conceptfactuur', 'verwijderen', 'weggooien', 'dubbel'],
    input: { invoice_id: { type: 'string', description: 'Id van de conceptfactuur.' } },
    required: ['invoice_id'],
    async plan(ctx, input) {
      const invoiceId = id(input, 'invoice_id');
      const inv = await row<{ number: string | null; status: string; journal_entry_id: string | null; sent_at: string | null; client_id: string | null }>(
        ctx, 'invoices', invoiceId, 'number, status, journal_entry_id, sent_at, client_id', 'Factuur');
      if (inv.journal_entry_id) throw new ActionError('Deze factuur staat in het grootboek en kan niet worden verwijderd. Maak een creditnota (invoice.credit) of boek de journaalpost tegen.');
      if (inv.status !== 'draft' || inv.sent_at) throw new ActionError(`Deze factuur is al verstuurd (status ${inv.status}) en valt onder de bewaarplicht. Crediteer hem (invoice.credit) in plaats van verwijderen.`);
      const client = inv.client_id ? await row<{ name: string }>(ctx, 'clients', inv.client_id, 'name', 'Klant') : null;
      return plan({
        title: `Conceptfactuur ${inv.number ?? ''} verwijderen`.replace(/\s+/g, ' '),
        sub: client?.name ?? 'zonder klant',
        kind: 'money',
        warning: IRREVERSIBLE,
        payload: { table: 'invoices', id: invoiceId, label: `Conceptfactuur ${inv.number ?? ''}`.trim() },
      });
    },
  },
  {
    id: 'quote.delete_draft',
    label: 'Een conceptofferte verwijderen',
    module: 'finance',
    kind: 'write',
    risk: 'high',
    description: 'Verwijdert een offerte die nog CONCEPT is en nooit naar de klant ging. Een verstuurde offerte valt onder de bewaarplicht: die trek je in (quote.withdraw). Zoek de offerte met `list_quotes`.',
    keywords: ['offerte', 'concept', 'conceptofferte', 'verwijderen', 'weggooien', 'dubbel'],
    input: { quote_id: { type: 'string', description: 'Id van de conceptofferte.' } },
    required: ['quote_id'],
    async plan(ctx, input) {
      const quoteId = id(input, 'quote_id');
      const quote = await row<{ number: string | null; status: string; sent_at: string | null; client_decision_at: string | null; client_id: string | null }>(
        ctx, 'quotes', quoteId, 'number, status, sent_at, client_decision_at, client_id', 'Offerte');
      if (quote.sent_at || quote.client_decision_at || ['sent', 'accepted', 'rejected', 'expired', 'paid', 'overdue'].includes(quote.status)) {
        throw new ActionError('Deze offerte is naar de klant gestuurd en valt onder de bewaarplicht. Trek hem in (quote.withdraw) of laat hem verlopen.');
      }
      const client = quote.client_id ? await row<{ name: string }>(ctx, 'clients', quote.client_id, 'name', 'Klant') : null;
      return plan({
        title: `Conceptofferte ${quote.number ?? ''} verwijderen`.replace(/\s+/g, ' '),
        sub: client?.name ?? 'zonder klant',
        kind: 'money',
        warning: IRREVERSIBLE,
        payload: { table: 'quotes', id: quoteId, label: `Conceptofferte ${quote.number ?? ''}`.trim() },
      });
    },
  },

  // ── Marketing en rapportages ──────────────────────────────────────────────
  {
    id: 'campaign.delete',
    label: 'Een e-mailcampagne verwijderen',
    module: 'marketing',
    kind: 'write',
    risk: 'high',
    description: 'Verwijdert een campagne die nog niet verstuurd is (concept, ingepland of geannuleerd). Een verstuurde campagne blijft staan als geschiedenis. Zoek hem met `list_campaigns`.',
    keywords: ['campagne', 'nieuwsbrief', 'verwijderen', 'concept', 'weggooien'],
    input: { campaign_id: { type: 'string', description: 'Id van de campagne.' } },
    required: ['campaign_id'],
    async plan(ctx, input) {
      const campaignId = id(input, 'campaign_id');
      const campaign = await row<{ name: string; status: string; sent_at: string | null }>(ctx, 'email_campaigns', campaignId, 'name, status, sent_at', 'Campagne');
      if (campaign.sent_at || ['sending', 'sent'].includes(campaign.status)) {
        throw new ActionError('Deze campagne is (deels) verstuurd; die blijft staan als geschiedenis.');
      }
      return plan({
        title: `Campagne "${campaign.name}" verwijderen`,
        sub: `status ${campaign.status}`,
        kind: 'mail',
        warning: IRREVERSIBLE,
        payload: { kind: 'campaign', id: campaignId, label: `Campagne "${campaign.name}"` },
      });
    },
  },
  {
    id: 'flow.delete',
    label: 'Een automatische e-mailstroom verwijderen',
    module: 'marketing',
    kind: 'write',
    risk: 'high',
    description: 'Verwijdert een automatische e-mailstroom met zijn stappen. Wie er nog in zat, krijgt geen volgende mail meer. Alleen even stilzetten? Gebruik flow.pause.',
    keywords: ['stroom', 'flow', 'automatisering', 'verwijderen', 'drip', 'reeks'],
    input: { flow_id: { type: 'string', description: 'Id van de stroom.' } },
    required: ['flow_id'],
    async plan(ctx, input) {
      const flowId = id(input, 'flow_id');
      const flow = await row<{ name: string; status: string }>(ctx, 'email_flows', flowId, 'name, status', 'Stroom');
      return plan({
        title: `E-mailstroom "${flow.name}" verwijderen`,
        sub: `status ${flow.status}`,
        kind: 'mail',
        warning: `${flow.status === 'active' ? 'Deze stroom loopt nog: wie erin zit, krijgt geen volgende mail meer. ' : ''}${IRREVERSIBLE}`,
        payload: { kind: 'flow', id: flowId, label: `Stroom "${flow.name}"` },
      });
    },
  },
  {
    id: 'saved_report.delete',
    label: 'Een opgeslagen rapport verwijderen',
    module: 'stats',
    kind: 'write',
    risk: 'high',
    description: 'Verwijdert een opgeslagen rapport uit de rapportbouwer. Zoek het met `saved_report.list`.',
    keywords: ['rapport', 'rapportage', 'grafiek', 'verwijderen'],
    input: { report_id: { type: 'string', description: 'Id van het rapport.' } },
    required: ['report_id'],
    async plan(ctx, input) {
      const reportId = id(input, 'report_id');
      const report = await row<{ name: string }>(ctx, 'saved_reports', reportId, 'name', 'Rapport');
      return plan({
        title: `Rapport "${report.name}" verwijderen`,
        sub: 'uit de rapportbouwer',
        kind: 'insight',
        warning: IRREVERSIBLE,
        payload: { kind: 'saved_report', id: reportId, label: `Rapport "${report.name}"` },
      });
    },
  },
  {
    id: 'ai_report.delete',
    label: 'Een rapportage (van Gerrie) verwijderen',
    module: 'stats',
    kind: 'write',
    risk: 'high',
    description: 'Verwijdert een rapportage die Gerrie onder Rapportages maakte, met al zijn versies.',
    keywords: ['rapportage', 'verwijderen', 'dashboard', 'rapport'],
    input: { report_id: { type: 'string', description: 'Id van de rapportage.' } },
    required: ['report_id'],
    async plan(ctx, input) {
      const reportId = id(input, 'report_id');
      const report = await ownAiReport(ctx, reportId);
      return plan({
        title: `Rapportage "${report.title}" verwijderen`,
        sub: 'met alle versies',
        kind: 'insight',
        warning: IRREVERSIBLE,
        payload: { kind: 'ai_report', id: reportId, label: `Rapportage "${report.title}"` },
      });
    },
  },
];
