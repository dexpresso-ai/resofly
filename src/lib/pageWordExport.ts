// ============================================================
// Een pagina als Word-bestand downloaden (stap 1B-2, in de app).
//
// Afwijking van §9 van het bouwplan, waar de edge function page-export de
// DOCX bouwt: voor alleen Word is de server niet nodig. Dezelfde module
// (_shared/pageDocx.ts) draait hier, met de rechten van wie exporteert (RLS),
// en met dezelfde letterkeuze als de server straks (_shared/pageExportFonts.ts).
// De server komt er pas bij met de PDF; die gebruikt dan dezelfde module.
//
// Sinds stap 1B-3 ook "Maak er een Word-document van": dezelfde .docx, als
// Word-document in het dossier (createPageWordCopy).
//
// Sinds stap 1B-5 bouwt de server (page-export) dezelfde .docx voor de PDF.
// Wat er met de opgehaalde gegevens gebeurt, staat daarom in
// _shared/pageExport.ts; hier alleen het ophalen, met de rechten van wie
// exporteert.
//
// De editor laadt dit bestand pas bij een klik (import()), zodat hij er niet
// zwaarder van wordt.
// ============================================================

import {
  buildPageDocx, type PageDocxChapter, type PageDocxCover, type PageDocxFont, type PageDocxImage, type PageDocxLetterhead,
} from '../../supabase/functions/_shared/pageDocx.ts';
import {
  exportBrand, exportContext, exportCover, exportLogo, exportOptions, exportReferences, letterheadMargins,
} from '../../supabase/functions/_shared/pageExport.ts';
import { pageExportFonts, type PageExportFont } from '../../supabase/functions/_shared/pageExportFonts.ts';
import { sfntFamilyName, woffToSfnt } from '../../supabase/functions/_shared/woff.ts';
import { LETTERHEAD_PDF_MESSAGE, wordFileName } from './pageExportParts';
import { documentAssetsFromSettings, PAGE_HEIGHT, parseDocumentLayouts, resolveDocumentLayout } from './documentLayout';
import { uploadDocumentDocx } from './office';
import { fetchStoredFileBlob } from './r2';
import { deleteR2Object } from './r2-api';
import { attachmentInfo, dossierNames, insertRow, loadInvoiceLetterhead, loadPage, pageTitle, pageTreePlace, type PageRow } from './repository';
import type { InternalDocument } from '../types';

/**
 * Eén letter van de huisstijl, als TTF. Laadt hij niet, dan alleen de naam: de
 * export gaat dan toch door, en Word kiest een vervanger.
 */
async function loadFont(font: PageExportFont): Promise<PageDocxFont> {
  const load = async (name: string | null) => {
    if (!name) return undefined;
    try {
      const response = await fetch(`/fonts/pdf/${name}.woff`);
      if (!response.ok) return undefined;
      return await woffToSfnt(new Uint8Array(await response.arrayBuffer()));
    } catch {
      return undefined;
    }
  };
  const [regular, bold] = await Promise.all([load(font.regular), load(font.bold)]);
  // De naam zoals de letter zichzelf noemt: daaronder zoekt Word hem.
  const family = (regular && sfntFamilyName(regular)) || (bold && sfntFamilyName(bold)) || font.family;
  return { family, regular, bold };
}

/**
 * Wat de export van de bedrijfsinstellingen gebruikt: de letters; voor het
 * voorblad, de kop en de voet de naam, het logo, de merkkleur en de
 * voettekst; voor het briefpapier het bestand en de marges uit Documentopmaak.
 */
export type PageWordHouseStyle = {
  organization_id?: string;
  brand_heading_font?: string | null;
  brand_body_font?: string | null;
  company_name?: string | null;
  brand_logo_data_url?: string | null;
  /** De merkkleur (#RRGGBB): een lijn onder de kop (stap 1B-4c). */
  brand_accent_color?: string | null;
  /** De voettekst van de huisstijl; zonder: de naam van het bedrijf. */
  brand_footer_text?: string | null;
  invoice_template_kind?: string | null;
  /** Ontbreekt (undefined) in de kern van de app: dan halen we het op (letterhead.ts). */
  invoice_template_data_url?: string | null;
  invoice_template_mime_type?: string | null;
  invoice_template_updated_at?: string | null;
  document_layouts?: unknown;
};

/** De keuzes in het exportvenster (stap 1B-4). */
export type PageWordOptions = {
  cover?: boolean;
  toc?: boolean;
  /** Het briefpapier van Documentopmaak, achter elke bladzijde (stap 1B-4b). */
  letterhead?: boolean;
  /** De subpagina's als hoofdstukken, in de volgorde van de boom (listSubpages). */
  chapters?: Array<{ id: string; title: string; depth: number }>;
};

/** Zoveel subpagina's tegelijk ophalen: genoeg voor snelheid, zonder de verbinding te verstoppen. */
const CHAPTER_LOADS = 6;

async function coverOf(row: PageRow, organizationId: string, houseStyle: PageWordHouseStyle | null, logo: PageDocxImage | null): Promise<PageDocxCover> {
  // Mag je de klant of het project niet zien, dan staat die regel er niet.
  const names = await dossierNames(row.client_id ?? null, row.project_id ?? null, organizationId).catch(() => ({ client: null, project: null }));
  return exportCover({
    clientName: names.client,
    projectName: names.project,
    date: new Date().toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }),
    company: houseStyle?.company_name ?? null,
    logo,
  });
}

/**
 * Het briefpapier voor Word (stap 1B-4b), zoals bij de PDF van een factuur
 * (letterhead.ts): gevraagd maar niet te laden, dan geen bestand. Nooit stil
 * zonder briefpapier: dat zie je pas als het bij de klant ligt.
 *
 * De marges komen uit Documentopmaak, zoals de vervolgbladzijden van een
 * factuur: boven de plek waar de inhoud begint (continueTop), onder de voet
 * (footerTop). Met het sjabloon "Voor briefpapier" laat dat zijn kop en voet vrij.
 */
async function letterheadOf(style: PageWordHouseStyle | null): Promise<PageDocxLetterhead> {
  const kind = style?.invoice_template_kind;
  if (!style || !kind || kind === 'none') throw new Error('Er is geen briefpapier ingesteld. Dat doe je bij Instellingen → Documentopmaak.');
  if (kind === 'pdf') throw new Error(LETTERHEAD_PDF_MESSAGE);
  let dataUrl = style.invoice_template_data_url;
  if (dataUrl === undefined) {
    try {
      if (!style.organization_id) throw new Error('geen organisatie');
      dataUrl = await loadInvoiceLetterhead(style.organization_id, style.invoice_template_updated_at ?? null);
    } catch {
      throw new Error('Het briefpapier kon niet worden geladen, dus er is geen Word-bestand gemaakt. Controleer je verbinding en probeer het opnieuw.');
    }
  }
  const paper = documentAssetsFromSettings({ ...style, invoice_template_data_url: dataUrl }).letterhead;
  if (!paper) throw new Error('Het briefpapier is leeg of niet te lezen. Kies het opnieuw bij Instellingen → Documentopmaak.');
  if (paper.kind === 'pdf') throw new Error(LETTERHEAD_PDF_MESSAGE);
  const layout = resolveDocumentLayout(parseDocumentLayouts(style.document_layouts), 'invoice', { letterhead: true });
  return {
    image: { bytes: paper.bytes, contentType: paper.type === 'png' ? 'image/png' : 'image/jpeg' },
    ...letterheadMargins(layout, PAGE_HEIGHT),
  };
}

/**
 * De subpagina's als hoofdstukken, in de gegeven volgorde. Laadt er een niet,
 * dan geen export: een bestand waar stil een hoofdstuk uit ontbreekt, valt
 * pas op als het bij de klant ligt.
 */
async function loadChapters(chapters: NonNullable<PageWordOptions['chapters']>, organizationId: string): Promise<PageDocxChapter[]> {
  const out: PageDocxChapter[] = new Array(chapters.length);
  let next = 0;
  const worker = async () => {
    while (next < chapters.length) {
      const index = next;
      next += 1;
      const chapter = chapters[index];
      try {
        const row = await loadPage(chapter.id, organizationId);
        out[index] = { title: row.title, body: row.body, depth: chapter.depth };
      } catch {
        throw new Error(`De subpagina "${chapter.title.trim() || 'Naamloze pagina'}" kon niet worden geladen, dus er is geen export gemaakt. Probeer het zo nog eens.`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHAPTER_LOADS, chapters.length) }, worker));
  return out;
}

/**
 * De opgeslagen pagina als .docx, in de huisstijl. De editor slaat eerst op:
 * de export leest wat in de database staat, zoals de server dat straks ook doet.
 * Met de opties van het exportvenster (stap 1B-4): een voorblad, een
 * inhoudsopgave vooraan, en de subpagina's als hoofdstukken.
 */
export async function buildPageWord(
  pageId: string,
  organizationId: string,
  houseStyle: PageWordHouseStyle | null,
  options: PageWordOptions = {},
): Promise<{ blob: Blob; fileName: string }> {
  const row = await loadPage(pageId, organizationId);
  const chapters = options.chapters?.length ? await loadChapters(options.chapters, organizationId) : [];
  // Wat de pagina en haar hoofdstukken noemen, samen: één bestand, één context.
  const refs = exportReferences([row.body, ...chapters.map(chapter => chapter.body)]);
  const fonts = pageExportFonts(houseStyle);
  const logo = exportLogo(houseStyle?.brand_logo_data_url);
  type Entry<T> = [string, T | null];
  const [titles, fileNames, images, body, heading, cover, letterhead] = await Promise.all([
    Promise.all(refs.pages.map(async (id): Promise<Entry<string>> => [id, await pageTitle(id, organizationId).catch(() => null)])),
    Promise.all(refs.files.map(async (id): Promise<Entry<string>> => [id, (await attachmentInfo(id, organizationId).catch(() => null))?.name ?? null])),
    Promise.all(refs.images.map(async (id): Promise<Entry<PageDocxImage>> => {
      try {
        const info = await attachmentInfo(id, organizationId);
        const blob = info ? await fetchStoredFileBlob(info.storage_key) : null;
        if (!info || !blob) return [id, null];
        return [id, { bytes: new Uint8Array(await blob.arrayBuffer()), contentType: info.mime_type }];
      } catch {
        // Een afbeelding die niet laadt, wordt in het bestand een regel "[Afbeelding]".
        return [id, null];
      }
    })),
    loadFont(fonts.body),
    fonts.heading.key === fonts.body.key ? null : loadFont(fonts.heading),
    options.cover ? coverOf(row, organizationId, houseStyle, logo) : null,
    options.letterhead ? letterheadOf(houseStyle) : null,
  ]);
  const context = exportContext({ titles, fileNames, images, font: body, headingFont: heading, brand: exportBrand(houseStyle, logo) });
  const blob = await buildPageDocx(row.title, row.body, context, exportOptions({ cover, toc: Boolean(options.toc), chapters, letterhead }));
  return { blob, fileName: wordFileName(row.title) };
}

/** Laat de browser het bestand opslaan. */
export function saveFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // Niet meteen: sommige browsers beginnen de download pas na deze taak.
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
}

/** De naam van de Word-kopie: de titel van de pagina, met "(Word)" erachter. */
export function wordCopyTitle(pageTitle: string): string {
  return `${pageTitle.trim() || 'Naamloze pagina'} (Word)`;
}

/**
 * "Maak er een Word-document van" (stap 1B-3, §9 van het bouwplan): de .docx
 * van buildPageWord als Word-document naast de pagina, voor de laatste puntjes
 * in Word. De pagina blijft de bron; wat je in de kopie wijzigt, komt niet
 * terug in de pagina.
 *
 * Hetzelfde pad als een geüpload Word-bestand (createDocumentFromOfficeFile in
 * main.tsx): de worker zet het bestand in R2, en de rij komt er met de rechten
 * van wie exporteert (RLS). Lukt de rij niet, dan gaat het bestand weer weg;
 * anders bleef het als wees in R2 staan, zonder rij die ernaar wijst.
 */
export async function createPageWordCopy(
  pageId: string,
  organizationId: string,
  title: string,
  blob: Blob,
): Promise<InternalDocument> {
  const place = await pageTreePlace(pageId, organizationId);
  const name = wordCopyTitle(title);
  const upload = await uploadDocumentDocx(organizationId, wordFileName(name), blob);
  try {
    return await insertRow<InternalDocument>('documents', organizationId, {
      title: name,
      document_type: place.document_type || 'general',
      client_id: place.client_id,
      project_id: place.project_id,
      folder_id: place.folder_id,
      // Zoals bij elk Word-document: de tekst staat in het bestand. Een kopie
      // van de tekst hier zou verouderen zodra iemand hem in Word bijwerkt.
      content: '',
      storage_key: upload.key,
      mime_type: upload.mime_type,
      size_bytes: upload.size_bytes,
    });
  } catch (error) {
    await deleteR2Object(upload.key).catch((cleanupError) => {
      console.warn('Word-kopie opruimen mislukt na een fout bij de documents-rij (mogelijk een wees in R2):', upload.key, cleanupError);
    });
    throw error;
  }
}
