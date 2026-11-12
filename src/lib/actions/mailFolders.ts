import {
  createClientEmailFolder, deleteClientEmailFolder, loadClientEmailFolders, moveClientEmailFolder, moveClientEmailThreads,
  renameClientEmailFolder,
} from '../repository';
import { mailFoldersChanged } from '../mailFolderEvents';
import { list, optText, text, type ActionExecutor } from './types';

/**
 * Uitvoerders voor de mailmappen (Berichten → mappen per klant). Wat Gerrie
 * belooft, staat in `supabase/functions/_shared/actions/mailFolders.ts`; hier
 * gebeurt het, met dezelfde rpc's als de knoppen op Berichten en dus met de
 * rechten van wie op Uitvoeren klikt.
 *
 * Na elke uitvoering: `mailFoldersChanged()`, zodat een open Berichten of
 * klantdossier meteen de nieuwe stand toont.
 */

/** "Bovenaan" of het pad van de map waarin iets komt, voor de bevestiging. */
const where = (payload: Record<string, unknown>) => optText(payload, 'target') ?? 'de map';

export const MAIL_FOLDER_EXECUTORS: Record<string, ActionExecutor> = {
  'mail_folder.create': async (payload, ctx) => {
    const folder = await createClientEmailFolder(ctx.organizationId, text(payload, 'client_id'), text(payload, 'name'), optText(payload, 'parent_id'));
    mailFoldersChanged();
    return `Mailmap "${folder.name}" gemaakt bij ${optText(payload, 'client_name') ?? 'de klant'}`;
  },

  'mail_folder.rename': async (payload, ctx) => {
    const folder = await renameClientEmailFolder(ctx.organizationId, text(payload, 'folder_id'), text(payload, 'name'));
    mailFoldersChanged();
    return `Mailmap "${optText(payload, 'was') ?? ''}" heet nu "${folder.name}"`;
  },

  'mail_folder.move': async (payload, ctx) => {
    await moveClientEmailFolder(ctx.organizationId, text(payload, 'folder_id'), optText(payload, 'parent_id'));
    mailFoldersChanged();
    const target = optText(payload, 'parent_id') ? `in "${where(payload)}"` : 'bovenaan';
    return `Mailmap "${optText(payload, 'folder_name') ?? ''}" staat nu ${target}`;
  },

  'mail_folder.delete': async (payload, ctx) => {
    await deleteClientEmailFolder(ctx.organizationId, text(payload, 'folder_id'));
    mailFoldersChanged();
    return `Mailmap "${optText(payload, 'folder_name') ?? ''}" verwijderd; de inhoud staat nu in ${optText(payload, 'destination') ?? 'de map erboven'}`;
  },

  'mail_thread.move': async (payload, ctx) => {
    const clientId = text(payload, 'client_id');
    const threadIds = list(payload, 'thread_ids');
    let folderId = optText(payload, 'folder_id');
    const newName = optText(payload, 'new_folder_name');
    if (newName) {
      // Eerst de map. Heeft een collega hem intussen al gemaakt (dezelfde naam op
      // dezelfde plek), dan gaan de gesprekken daarin in plaats van dat het
      // voorstel strandt op "Er staat al een map".
      const parentId = optText(payload, 'new_folder_parent_id');
      const existing = (await loadClientEmailFolders(ctx.organizationId) ?? []).find((f) =>
        f.client_id === clientId && (f.parent_id ?? null) === parentId && f.name.toLocaleLowerCase('nl') === newName.toLocaleLowerCase('nl'));
      folderId = existing ? existing.id : (await createClientEmailFolder(ctx.organizationId, clientId, newName, parentId)).id;
    }
    const moved = await moveClientEmailThreads(ctx.organizationId, threadIds, folderId);
    mailFoldersChanged();
    const count = moved === 1 ? '1 gesprek' : `${moved} gesprekken`;
    return folderId
      ? `${count} van ${optText(payload, 'client_name') ?? 'de klant'} verplaatst naar "${where(payload)}"`
      : `${count} van ${optText(payload, 'client_name') ?? 'de klant'} terug naar "Zonder map"`;
  },
};
