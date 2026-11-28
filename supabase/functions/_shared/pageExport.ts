// ============================================================
// De Word-export van een pagina samenstellen (stap 1B-5, §9 van het bouwplan).
//
// Twee plekken bouwen dezelfde .docx:
//  - de app (src/lib/pageWordExport.ts): Word downloaden en de Word-kopie;
//  - de server (page-export): de PDF, via Collabora.
// Wat ze ophalen, en hoe, verschilt: de app met supabase-js in de browser, de
// server met de sessie van wie exporteert en de interne weg naar R2. Wat ze
// ermee doen, staat hier één keer. Anders lopen Word en PDF uit elkaar, en
// dat wil §9 juist voorkomen ("Eén route: pagina → DOCX → PDF").
//
// Puur: geen database, geen netwerk, geen klok. De datum komt als tekst
// binnen, de marges van het briefpapier als getallen uit Documentopmaak.
// ============================================================

import type {
  PageDocxBrand, PageDocxChapter, PageDocxContext, PageDocxCover, PageDocxFont, PageDocxImage, PageDocxLetterhead, PageDocxOptions,
} from './pageDocx.ts';
import { pageReferences } from './pageReferences.ts';
import { subpagesOf, type OrderedPage } from './pageTreeOrder.ts';

/** Zoveel subpagina's gaan hoogstens als hoofdstukken mee in één export (stap 1B-4). */
export const EXPORT_SUBPAGE_LIMIT = 200;

/** Wat de export van een pagina kiest (het exportvenster). */
export type PageExportChoice = { cover?: boolean; toc?: boolean; chapters?: boolean; letterhead?: boolean };

/** Wat de export van de bedrijfsinstellingen gebruikt voor het voorblad, de kop en de voet. */
export type PageExportStyle = {
  company_name?: string | null;
  brand_logo_data_url?: string | null;
  brand_accent_color?: string | null;
  brand_footer_text?: string | null;
};

/** Wat een pagina en haar hoofdstukken noemen, samen: één bestand, één context. */
export function exportReferences(bodies: unknown[]): { pages: string[]; files: string[]; images: string[] } {
  const found = bodies.map(pageReferences);
  const unique = (ids: string[]) => [...new Set(ids)];
  return {
    pages: unique(found.flatMap(refs => refs.pages)),
    files: unique(found.flatMap(refs => refs.files)),
    images: unique(found.flatMap(refs => refs.images)),
  };
}

/**
 * De subpagina's onder een pagina, in de volgorde van de boom: de hoofdstukken.
 * Per laag één vraag (`children`, met de rechten van wie exporteert: wat je
 * niet mag zien of wat in de prullenbak ligt, geeft de database niet). Hoogstens
 * 20 lagen, zoals de boom in de database. `tooMany`: meer dan
 * EXPORT_SUBPAGE_LIMIT; dan is de lijst niet compleet, en exporteren we ze niet.
 */
export async function collectSubpages<T extends OrderedPage>(
  rootId: string,
  children: (parentIds: string[]) => Promise<T[]>,
): Promise<{ subpages: Array<{ page: T; depth: number }>; tooMany: boolean }> {
  const pages: T[] = [];
  const seen = new Set<string>([rootId]);
  let parents = [rootId];
  for (let depth = 0; parents.length > 0 && depth < 20; depth += 1) {
    const level: T[] = [];
    for (const row of await children(parents)) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      level.push(row);
    }
    pages.push(...level);
    if (pages.length > EXPORT_SUBPAGE_LIMIT) return { subpages: [], tooMany: true };
    parents = level.map(page => page.id);
  }
  return { subpages: subpagesOf(pages, rootId), tooMany: false };
}

/** Alleen wat gevonden is: een titel of afbeelding die we niet mochten of konden zien, valt weg. */
export function known<T>(entries: Array<[string, T | null]>): Record<string, T> {
  return Object.fromEntries(entries.filter((entry): entry is [string, T] => entry[1] !== null));
}

/** Een data-URL als bytes en type; null als het er geen is. Zoals dataUrlBytes in documentLayout. */
function decodeDataUrl(value: string | null | undefined): { bytes: Uint8Array; mime: string } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(typeof value === 'string' ? value : '');
  if (!match) return null;
  try {
    const payload = match[3] ?? '';
    const binary = match[2] ? atob(payload) : decodeURIComponent(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return { bytes, mime: (match[1] || 'application/octet-stream').toLowerCase() };
  } catch {
    return null;
  }
}

/** Het logo voor het voorblad en de kop, als png, jpeg of gif; iets anders (svg, webp) kan Word niet tonen. */
export function exportLogo(dataUrl: string | null | undefined): PageDocxImage | null {
  const logo = decodeDataUrl(dataUrl);
  if (!logo) return null;
  const contentType = logo.mime === 'image/jpg' ? 'image/jpeg' : logo.mime;
  return /^image\/(png|jpeg|gif)$/.test(contentType) ? { bytes: logo.bytes, contentType } : null;
}

/** Kop en voet in de huisstijl (stap 1B-4c): het logo, de merkkleur, en de voettekst of anders de bedrijfsnaam. */
export function exportBrand(style: PageExportStyle | null, logo: PageDocxImage | null): PageDocxBrand {
  return {
    logo,
    color: style?.brand_accent_color ?? null,
    footerText: style?.brand_footer_text?.trim() || style?.company_name?.trim() || null,
  };
}

/** Het voorblad (stap 1B-4a): de klant en het project als je die mag zien, en de datum als tekst. */
export function exportCover(input: {
  clientName: string | null; projectName: string | null; date: string; company: string | null; logo: PageDocxImage | null;
}): PageDocxCover {
  return {
    lines: [input.clientName ? `Klant: ${input.clientName}` : '', input.projectName ? `Project: ${input.projectName}` : ''],
    date: input.date,
    company: input.company?.trim() || null,
    logo: input.logo,
  };
}

/**
 * De marges van het briefpapier (stap 1B-4b), uit Documentopmaak, zoals op de
 * vervolgbladzijden van een factuur: boven waar de inhoud begint (continueTop),
 * onder waar de voet begint (footerTop). Punten (1/72 inch) naar twips (1/20
 * punt). pageDocx houdt minstens de gewone marge aan.
 */
export function letterheadMargins(layout: { continueTop: number; footerTop: number }, pageHeightPt: number): { top: number; bottom: number } {
  return { top: Math.round(layout.continueTop * 20), bottom: Math.round((pageHeightPt - layout.footerTop) * 20) };
}

/** De context van pageDocx: wat gevonden is, de letters, en de huisstijl in kop en voet. */
export function exportContext(input: {
  titles: Array<[string, string | null]>;
  fileNames: Array<[string, string | null]>;
  images: Array<[string, PageDocxImage | null]>;
  font: PageDocxFont;
  headingFont: PageDocxFont | null;
  brand: PageDocxBrand;
}): PageDocxContext {
  return {
    // Een titel die we niet mogen of kunnen zien, laat pageDocx als "Pagina niet gevonden" staan.
    pageTitles: known(input.titles),
    fileNames: known(input.fileNames),
    images: known(input.images),
    font: input.font,
    headingFont: input.headingFont ?? input.font,
    // Met briefpapier laat pageDocx de kop en voet in de huisstijl weg.
    brand: input.brand,
  };
}

/** De opties van pageDocx, uit wat gekozen en opgehaald is. */
export function exportOptions(input: {
  cover: PageDocxCover | null; toc: boolean; chapters: PageDocxChapter[]; letterhead: PageDocxLetterhead | null;
}): PageDocxOptions {
  return { cover: input.cover, toc: input.toc, chapters: input.chapters, letterhead: input.letterhead };
}
