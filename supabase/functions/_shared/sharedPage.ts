// ============================================================
// Een gedeeld document lezen, voor het portaal en de geheime link
// (stap 1C-2, docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md §7).
//
// Bij een pagina leest de klant de versie die gedeeld is
// (drive_shares.document_version_id), als HTML uit renderPageHtml. Nooit de
// pagina zoals ze nu is: een pagina zonder geldige versie, of in de
// prullenbak, geeft niets. Terugvallen op documents.content zou de levende
// tekst tonen, en dat is precies wat delen-is-vrijgeven moet voorkomen.
//
// Een tekstdocument blijft zoals het was: de opgeslagen HTML (content), die
// het portaal zelf nog saneert.
//
// De service-role slaat RLS over. Daarom filtert elke vraag hier zelf op de
// organisatie van de deling (CLAUDE.md, regel 1), en op de pagina zelf.
//
// Afbeeldingen en bestandsnamen komen uit shared_page_attachments
// (20261128140000): alleen bijlagen uit de gedeelde versie die nú nog in het
// dossier van de pagina horen. De versie ligt vast, maar een bestand kan
// daarna naar een andere klant verhuizen.
// ============================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { renderPageHtml, type PageHtmlContext } from './pageHtml.ts';
import { pageReferences } from './pageReferences.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** De deling zoals de aanroeper hem al geverifieerd heeft (via de token of het ingelogde adres). */
export type SharedDocumentShare = { id: string; organization_id: string };

/**
 * Welke subpagina's de lezer ook mag zien, met hun titel. De aanroeper weet
 * welke delingen bij deze lezer horen; zonder deze functie verschijnt geen
 * enkele subpagina.
 */
export type VisibleSubpages = (pageIds: string[]) => Promise<PageHtmlContext['subpages']>;

export type SharedDocumentText = { title: string; html: string };

/**
 * Getekende adressen voor afbeeldingen: attachmentId → https-adres. De
 * aanroeper tekent (pageImageSigner in fileTransferServer.ts); zonder deze
 * functie staat er "[Afbeelding]".
 */
export type SignPageImages = (files: Array<{ id: string; key: string; name: string }>) => Promise<Record<string, string>>;

type SharedOptions = { subpages?: VisibleSubpages; images?: SignPageImages };

/** De beeldtypes die de worker inline toont, en die een browser in <img> laat zien. Geen svg: dat kan script bevatten. */
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|avif)$/i;

/**
 * De tekst van een gedeeld document (een tekstdocument of een pagina), of
 * null als er niets te tonen is.
 */
export async function sharedDocumentText(
  admin: SupabaseClient,
  share: SharedDocumentShare,
  documentId: string,
  options: SharedOptions = {},
): Promise<SharedDocumentText | null> {
  if (!UUID.test(documentId)) return null;
  const { data, error } = await admin
    .from('documents')
    .select('title,content,format,archived_at')
    .eq('id', documentId)
    .eq('organization_id', share.organization_id)
    .maybeSingle();
  if (error) throw error;
  const doc = data as { title: string | null; content: string | null; format: string | null; archived_at: string | null } | null;
  if (!doc) return null;
  if (doc.format !== 'page') return { title: doc.title ?? '', html: doc.content || '' };
  if (doc.archived_at) return null;
  return sharedPageText(admin, share, documentId, options);
}

async function sharedPageText(
  admin: SupabaseClient,
  share: SharedDocumentShare,
  pageId: string,
  options: SharedOptions,
): Promise<SharedDocumentText | null> {
  // De versie staat op de deling zelf. Alleen een deling van precies deze
  // pagina telt: een map neemt geen pagina's mee (drive_folder_tree_items).
  const { data: shareData, error: shareError } = await admin
    .from('drive_shares')
    .select('item_type,item_id,document_version_id')
    .eq('id', share.id)
    .eq('organization_id', share.organization_id)
    .maybeSingle();
  if (shareError) throw shareError;
  const row = shareData as { item_type: string; item_id: string; document_version_id: string | null } | null;
  if (!row || row.item_type !== 'document' || row.item_id !== pageId || !row.document_version_id) return null;

  const { data: versionData, error: versionError } = await admin
    .from('document_versions')
    .select('title,body')
    .eq('id', row.document_version_id)
    .eq('organization_id', share.organization_id)
    .eq('document_id', pageId)
    .maybeSingle();
  if (versionError) throw versionError;
  const version = versionData as { title: string | null; body: unknown } | null;
  if (!version) return null;

  const refs = pageReferences(version.body);
  const pageIds = refs.pages.filter(id => UUID.test(id) && id !== pageId);
  const context: PageHtmlContext = {};
  if (refs.files.length > 0 || refs.images.length > 0) {
    const { data: attachmentData, error: attachmentError } = await admin.rpc('shared_page_attachments', { p_share_id: share.id });
    if (attachmentError) throw attachmentError;
    const attachments = (attachmentData ?? []) as Array<{ attachment_id: string; kind: string; name: string; storage_key: string | null; mime_type: string | null }>;
    context.fileNames = Object.fromEntries(attachments.filter(row => row.kind === 'fileBlock').map(row => [row.attachment_id, row.name]));
    const images = attachments.filter(row => row.kind === 'image' && row.storage_key && IMAGE_TYPES.test(row.mime_type ?? ''));
    if (images.length > 0 && options.images) {
      try {
        const signed = await options.images(images.map(row => ({ id: row.attachment_id, key: row.storage_key as string, name: row.name })));
        context.images = Object.fromEntries(Object.entries(signed).map(([id, src]) => [id, { src }]));
      } catch (error) {
        // Geen getekend adres (de opslag is even weg): dan "[Afbeelding]", maar de pagina zelf wel.
        console.warn('sharedPage: afbeeldingen niet getekend', error instanceof Error ? error.message : error);
      }
    }
  }
  if (pageIds.length > 0 && options.subpages) context.subpages = await options.subpages(pageIds);

  return { title: version.title ?? '', html: renderPageHtml(version.body, context) };
}
