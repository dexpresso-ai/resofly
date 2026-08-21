import {
  insertRow, linkInboundMessage, sendClientPortalWelcomeEmail, setInboundMessageStatus,
  updateClientContact, updateRow,
} from '../repository';
import { flag, list, optText, patchOf, text, type ActionExecutor } from './types';
import type { ClientFieldDefinition, ContentFolder } from '../../types';

/**
 * Uitvoerders voor de klant-handelingen. Elke functie doet precies wat de knop in
 * het scherm doet — zie `supabase/functions/_shared/actions/clients.ts` voor wat er
 * aan de gebruiker beloofd wordt op de kaart die hij goedkeurt.
 */
export const CLIENT_EXECUTORS: Record<string, ActionExecutor> = {
  'client.update_details': async (payload, ctx) => {
    const clientId = text(payload, 'client_id');
    await updateRow('clients', clientId, patchOf(payload), ctx.organizationId);
    return `Klantgegevens van ${optText(payload, 'client_name') ?? 'de klant'} bijgewerkt`;
  },

  'client.set_custom_fields': async (payload, ctx) => {
    const clientId = text(payload, 'client_id');
    await updateRow('clients', clientId, { custom_fields: patchOf(payload, 'custom_fields') }, ctx.organizationId);
    return `Klantvelden van ${optText(payload, 'client_name') ?? 'de klant'} ingevuld`;
  },

  'client.send_portal_welcome': async (payload, ctx) => {
    const clientId = text(payload, 'client_id');
    const result = await sendClientPortalWelcomeEmail(ctx.organizationId, clientId);
    const to = result.recipientEmail ?? optText(payload, 'email') ?? 'de klant';
    return `Portaaluitnodiging verstuurd naar ${to}`;
  },

  'client_contact.set_active': async (payload, ctx) => {
    const contactId = text(payload, 'contact_id');
    const active = flag(payload, 'is_active');
    await updateClientContact(contactId, { is_active: active }, ctx.organizationId);
    return `${optText(payload, 'name') ?? 'Contactpersoon'} staat nu ${active ? 'actief' : 'inactief'}`;
  },

  'client_contact.set_portal_access': async (payload, ctx) => {
    const contactIds = list(payload, 'contact_ids');
    const grant = flag(payload, 'gives_portal_access');
    // Per contactpersoon, zodat een mislukte rij de rest niet meesleept en je aan de
    // melding ziet hoeveel er wél goed gingen.
    const failed: string[] = [];
    const names = Array.isArray(payload.names) ? (payload.names as unknown[]).map(String) : [];
    for (let i = 0; i < contactIds.length; i += 1) {
      try { await updateClientContact(contactIds[i], { gives_portal_access: grant }, ctx.organizationId); }
      catch { failed.push(names[i] ?? contactIds[i]); }
    }
    if (failed.length) throw new Error(`${contactIds.length - failed.length} bijgewerkt, ${failed.length} mislukt (${failed.join(', ')}).`);
    return `${contactIds.length} contactperso${contactIds.length === 1 ? 'on' : 'nen'} ${grant ? 'heeft' : 'heeft geen'} portaaltoegang`;
  },

  'client_field.create': async (payload, ctx) => {
    const created = await insertRow<ClientFieldDefinition>('client_field_definitions', ctx.organizationId, {
      field_key: text(payload, 'field_key'),
      label: text(payload, 'label'),
      field_type: text(payload, 'field_type'),
      options: Array.isArray(payload.options) ? payload.options : [],
      help_text: optText(payload, 'help_text'),
      default_fallback: optText(payload, 'default_fallback'),
      show_in_list: flag(payload, 'show_in_list'),
      position: typeof payload.position === 'number' ? payload.position : 0,
      is_archived: false,
    });
    return `Klantveld "${created.label}" aangemaakt — te gebruiken als {{veld.${created.field_key}}}`;
  },

  'client_field.update': async (payload, ctx) => {
    const fieldId = text(payload, 'field_id');
    await updateRow('client_field_definitions', fieldId, patchOf(payload), ctx.organizationId);
    return `Klantveld "${optText(payload, 'label') ?? ''}" bijgewerkt`.replace('  ', ' ');
  },

  'client_field.archive': async (payload, ctx) => {
    const fieldId = text(payload, 'field_id');
    const archived = flag(payload, 'is_archived');
    await updateRow('client_field_definitions', fieldId, { is_archived: archived }, ctx.organizationId);
    return `Klantveld "${optText(payload, 'label') ?? ''}" ${archived ? 'gearchiveerd' : 'teruggezet'}`;
  },

  'inbox.link': async (payload, ctx) => {
    await linkInboundMessage(
      ctx.organizationId,
      text(payload, 'message_id'),
      text(payload, 'client_id'),
      flag(payload, 'remember_sender'),
    );
    return `Bericht staat nu in het dossier van ${optText(payload, 'client_name') ?? 'de klant'}`;
  },

  'inbox.ignore': async (payload, ctx) => {
    const status = text(payload, 'status') as 'dropped' | 'unmatched';
    await setInboundMessageStatus(ctx.organizationId, text(payload, 'message_id'), status);
    return status === 'dropped' ? 'Bericht genegeerd' : 'Bericht staat weer in de opvangbak';
  },

  'folder.create': async (payload, ctx) => {
    const parentId = optText(payload, 'parent_id');
    const projectId = optText(payload, 'project_id');
    const clientId = text(payload, 'client_id');
    // Positie achteraan binnen dezelfde ouder — zoals het scherm het ook doet.
    const siblings = ctx.data.folders.filter((f) =>
      f.client_id === clientId && (f.parent_id ?? null) === parentId && (f.project_id ?? null) === projectId);
    const created = await insertRow<ContentFolder>('content_folders', ctx.organizationId, {
      client_id: clientId, project_id: projectId, parent_id: parentId,
      name: text(payload, 'name'), position: siblings.length,
    });
    return `Map "${created.name}" aangemaakt`;
  },

  'folder.rename': async (payload, ctx) => {
    await updateRow('content_folders', text(payload, 'folder_id'), { name: text(payload, 'name') }, ctx.organizationId);
    return `Map heet nu "${text(payload, 'name')}"`;
  },

  'content.move': async (payload, ctx) => {
    const kind = text(payload, 'kind');
    const table = kind === 'note' ? 'notes' : 'documents';
    await updateRow(table, text(payload, 'item_id'), { folder_id: optText(payload, 'folder_id') }, ctx.organizationId);
    return `${kind === 'note' ? 'Notitie' : 'Document'} "${optText(payload, 'title') ?? ''}" staat nu in ${optText(payload, 'folder_name') ?? 'geen map'}`;
  },
};
