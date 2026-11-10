import {
  loadContentHtml, moveAttachmentToFolder, renameAttachment, revokeDriveShare, shareDriveItem, updateRow,
  type DriveShareRecipientInput,
} from '../repository';
import { sanitizeRichText } from '../../components/RichTextEditor';
import { optText, patchOf, text, type ActionExecutor, type ActionRunCtx } from './types';
import type { DriveShareItemType } from '../../types';

/**
 * Uitvoerders voor de inhoud: notities en documenten bijwerken, bestanden
 * hernoemen en verplaatsen, en delen. Elke uitvoerder gaat langs dezelfde
 * functie als het scherm — zie `supabase/functions/_shared/actions/content.ts`
 * voor wat de kaart belooft.
 */

/**
 * Notitie of document bijwerken, met dezelfde opschoning als het formulier
 * (`sanitizeRichText`): platte tekst wordt alinea's, HTML wordt gezuiverd.
 *
 * "Aanvullen" leest de tekst van NU en zet de aanvulling eronder. Op de kopie
 * van het voorstel voortbouwen zou weggooien wat een collega intussen typte.
 */
async function updateContent(payload: Record<string, unknown>, ctx: ActionRunCtx): Promise<string> {
  const kind = text(payload, 'kind') === 'note' ? 'note' : 'document';
  const table = kind === 'note' ? 'notes' : 'documents';
  const itemId = text(payload, 'item_id');
  const patch = { ...patchOf(payload) };
  if (typeof patch.content === 'string') {
    const addition = sanitizeRichText(patch.content);
    if (payload.content_mode === 'append') {
      const current = await loadContentHtml(table, itemId, ctx.organizationId);
      patch.content = sanitizeRichText(`${current}${addition}`);
    } else {
      patch.content = addition;
    }
  }
  await updateRow(table, itemId, patch, ctx.organizationId);
  const label = kind === 'note' ? 'Notitie' : 'Document';
  return `${label} "${String(patch.title ?? optText(payload, 'title') ?? '')}" bijgewerkt`.replace(' ""', '');
}

export const CONTENT_EXECUTORS: Record<string, ActionExecutor> = {
  'note.update': (payload, ctx) => updateContent(payload, ctx),
  'document.update': (payload, ctx) => updateContent(payload, ctx),

  'attachment.rename': async (payload, ctx) => {
    const name = text(payload, 'name');
    await renameAttachment(text(payload, 'attachment_id'), name, ctx.organizationId);
    return `Bestand heet nu "${name}"`;
  },

  'attachment.move': async (payload, ctx) => {
    await moveAttachmentToFolder(text(payload, 'attachment_id'), text(payload, 'folder_id'), ctx.organizationId);
    return `"${optText(payload, 'name') ?? 'Bestand'}" staat nu in map ${optText(payload, 'folder_name') ?? ''}`.trim();
  },

  'drive.share': async (payload, ctx) => {
    const recipients = Array.isArray(payload.recipients) ? payload.recipients as DriveShareRecipientInput[] : [];
    if (recipients.length === 0) throw new Error('Deze deling heeft geen ontvangers.');
    const results = await shareDriveItem({
      organizationId: ctx.organizationId,
      itemType: text(payload, 'item_type') as DriveShareItemType,
      itemId: text(payload, 'item_id'),
      itemName: optText(payload, 'item_name'),
      recipients,
      canDownload: payload.can_download !== false,
      // Het eind van de gekozen dag, zoals het deelvenster een vervaldatum ook als tijdstip opslaat.
      expiresAt: optText(payload, 'expires_date') ? new Date(`${optText(payload, 'expires_date')}T23:59:59`).toISOString() : null,
      message: optText(payload, 'message'),
      notify: true,
    });
    const ok = results.filter((r) => r.share);
    const failed = results.filter((r) => !r.share);
    const name = optText(payload, 'item_name') ?? 'het item';
    if (ok.length === 0) {
      throw new Error(`Delen van "${name}" lukte niet: ${failed.map((r) => r.error).filter(Boolean).join('; ') || 'onbekende fout'}`);
    }
    const parts = [`"${name}" gedeeld (${ok.length} ontvanger${ok.length === 1 ? '' : 's'})`];
    const unnotified = ok.filter((r) => !r.notified).length;
    if (unnotified > 0) parts.push(`${unnotified} melding${unnotified === 1 ? '' : 'en'} kwam${unnotified === 1 ? '' : 'en'} niet aan`);
    if (failed.length > 0) parts.push(`niet gelukt bij ${failed.length}: ${failed.map((r) => r.error).filter(Boolean).join('; ')}`);
    return parts.join('; ');
  },

  'drive.revoke_share': async (payload, ctx) => {
    await revokeDriveShare(text(payload, 'share_id'), ctx.organizationId);
    return `Deling van "${optText(payload, 'item_name') ?? 'het item'}" met ${optText(payload, 'recipient') ?? 'de ontvanger'} ingetrokken`;
  },
};
