// ============================================================
// Een pagina als Word-bestand downloaden (stap 1B-2, in de app).
//
// Afwijking van §9 van het bouwplan, waar de edge function page-export de
// DOCX bouwt: voor alleen Word is de server niet nodig. Dezelfde module
// (_shared/pageDocx.ts) draait hier, met de rechten van wie exporteert (RLS),
// en met dezelfde letterkeuze als de server straks (_shared/pageExportFonts.ts).
// De server komt er pas bij met de PDF; die gebruikt dan dezelfde module.
//
// De editor laadt dit bestand pas bij een klik (import()), zodat hij er niet
// zwaarder van wordt.
// ============================================================

import { buildPageDocx, type PageDocxContext, type PageDocxFont, type PageDocxImage } from '../../supabase/functions/_shared/pageDocx.ts';
import { pageExportFonts, type PageExportFont } from '../../supabase/functions/_shared/pageExportFonts.ts';
import { sfntFamilyName, woffToSfnt } from '../../supabase/functions/_shared/woff.ts';
import { pageReferences, wordFileName } from './pageExportParts';
import { fetchStoredFileBlob } from './r2';
import { attachmentInfo, loadPage, pageTitle } from './repository';

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
 * De opgeslagen pagina als .docx, in de huisstijl. De editor slaat eerst op:
 * de export leest wat in de database staat, zoals de server dat straks ook doet.
 */
export async function buildPageWord(
  pageId: string,
  organizationId: string,
  houseStyle: { brand_heading_font?: string | null; brand_body_font?: string | null } | null,
): Promise<{ blob: Blob; fileName: string }> {
  const row = await loadPage(pageId, organizationId);
  const refs = pageReferences(row.body);
  const fonts = pageExportFonts(houseStyle);
  type Entry<T> = [string, T | null];
  const [titles, fileNames, images, body, heading] = await Promise.all([
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
  ]);
  const known = <T,>(entries: Entry<T>[]): Record<string, T> =>
    Object.fromEntries(entries.filter((entry): entry is [string, T] => entry[1] !== null));
  const context: PageDocxContext = {
    // Een titel die we niet mogen of kunnen zien, laat pageDocx als "Pagina niet gevonden" staan.
    pageTitles: known(titles),
    fileNames: known(fileNames),
    images: known(images),
    font: body,
    headingFont: heading ?? body,
  };
  return { blob: await buildPageDocx(row.title, row.body, context), fileName: wordFileName(row.title) };
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
